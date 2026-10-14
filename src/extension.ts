import * as vscode from "vscode";

import { onSettingsChanged, readSettings } from "./config.js";
import { usageMemory } from "./shared/usage.js";
import { describeError, log } from "./logger.js";
import { ChatSession } from "./session/chat-session.js";
import { registerDiffProviders } from "./ui/diff-preview.js";
import { ChatViewHost } from "./ui/chat-view.js";

const SESSION_KEY = "opencode.lastSession";
/**
 * Global on purpose: the TUI keeps its model memory in a single user-wide
 * `model.json`, so switching folders does not reset the model here either.
 */
const MODEL_KEY = "opencode.lastModel";
/**
 * Global for the same reason as the model: the figures belong to a model, not
 * to a folder, so opening another workspace should not blank the counter. The
 * store is keyed by session id, which is what keeps one chat's context off
 * another's meter.
 */
const USAGE_KEY = "opencode.lastUsage";

/** Workspace files offered when there is no editor to attach. */
const WORKSPACE_FILE_GLOB = "**/*";
const WORKSPACE_FILE_EXCLUDE = "**/{node_modules,.git,dist,out,build,target,vendor,.venv,.next,.cache}/**";
const ATTACH_PICKER_LIMIT = 200;

let view: ChatViewHost | undefined;
let session: ChatSession | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const diffs = registerDiffProviders(context);
  session = new ChatSession(
    (workspaceUri) => workspaceUri?.fsPath ?? firstWorkspacePath(context),
    {
      read: () => {
        const value = context.globalState.get<unknown>(MODEL_KEY);
        return typeof value === "string" ? value : undefined;
      },
      write: (modelId) => void context.globalState.update(MODEL_KEY, modelId),
    },
    usageMemory(
      () => context.globalState.get<unknown>(USAGE_KEY),
      (store) => void context.globalState.update(USAGE_KEY, store),
    ),
  );

  view = new ChatViewHost(context.extensionUri, session, diffs, {
    lastSessionId: () => readLastSession(context),
  });

  context.subscriptions.push(
    view,
    vscode.window.registerWebviewViewProvider(ChatViewHost.viewType, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    onSettingsChanged(() => view?.pushState()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void restartForWorkspace();
    }),
    // `changed` can fire on every streamed chunk, so the persisted session id
    // and the command-palette contexts are only touched when their values flip.
    session.changed(() => {
      syncSessionPersistence(context, session);
      syncCommandContexts(session);
    }),
  );

  registerCommands(context, session, view);

  log.info("OpenCode extension activated");
}

export function deactivate(): void {
  session?.dispose();
  session = undefined;
  view = undefined;
}

/* ------------------------------------------------------------------ */
/* Commands                                                             */
/* ------------------------------------------------------------------ */

function registerCommands(
  context: vscode.ExtensionContext,
  chat: ChatSession,
  host: ChatViewHost,
): void {
  const register = (command: string, handler: (...args: never[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler as never));
  };

  /**
 * Focuses the chat view.
 *
 * Deliberately not called `opencode.chat.focus`: VS Code registers
 * `<viewId>.focus` for the view of the same name, and a contributed command
 * cannot take that ID.
 */
register("opencode.chat.open", async () => {
    await vscode.commands.executeCommand(`${ChatViewHost.viewType}.focus`);
  });

  register("opencode.chat.openInEditor", async () => {
    await host.openInEditor();
  });

  register("opencode.chat.newSession", async () => {
    await host.ensureStarted();
    await run(() => chat.newChat());
    host.focusInput();
  });

  register("opencode.chat.stop", async () => {
    await chat.cancel();
  });

  register("opencode.chat.restart", async () => {
    await run(() => chat.restart());
  });

  register("opencode.chat.signIn", async () => {
    await run(() => chat.runSignIn());
  });

  register("opencode.chat.pickSession", async () => {
    await host.ensureStarted();
    const cwd = chat.snapshot().cwd ?? firstWorkspacePath(context);
    let sessions: Awaited<ReturnType<ChatSession["listSessions"]>> = [];
    try {
      sessions = await chat.listSessions(cwd);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not list OpenCode sessions: ${describeError(error)}`);
      return;
    }
    if (!sessions.length) {
      void vscode.window.showInformationMessage("No previous OpenCode chats for this folder yet.");
      return;
    }

    const currentId = chat.snapshot().session?.sessionId;
    const items = sessions.map((entry) => ({
      label: entry.title?.trim() || "(untitled)",
      description: relativeTime(entry.updatedAt),
      detail: entry.cwd,
      id: entry.sessionId,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      title: "Resume an OpenCode chat",
      placeHolder: "Choose a conversation",
      matchOnDescription: true,
    });
    if (!picked) {
      return;
    }
    if (picked.id === currentId) {
      return;
    }
    await run(() => chat.openSession(picked.id, cwd));
  });

  register("opencode.chat.explainSelection", async () => {
    const contextInfo = activeEditorContext();
    if (!contextInfo) {
      return;
    }
    host.insertDraft(`Explain this code:\n\n${contextInfo}`);
    await vscode.commands.executeCommand(`${ChatViewHost.viewType}.focus`);
    host.focusInput();
  });

  register("opencode.chat.askAboutSelection", async () => {
    const contextInfo = activeEditorContext();
    if (!contextInfo) {
      return;
    }
    host.submitDraft(`What does this do?\n\n${contextInfo}`);
    await vscode.commands.executeCommand(`${ChatViewHost.viewType}.focus`);
  });

  register("opencode.chat.askAboutFile", async () => {
    // Without a focused editor there is nothing to attach, so the button asks
    // for one instead of doing nothing at all.
    const target = vscode.window.activeTextEditor?.document.uri ?? (await pickFileToAttach());
    if (!target) {
      return;
    }
    const relative = vscode.workspace.asRelativePath(target);
    await vscode.commands.executeCommand(`${ChatViewHost.viewType}.focus`);
    host.insertDraft(`About \`${relative}\`: `);
    host.focusInput();
  });

  register("opencode.chat.copyLastResponse", async () => {
    const text = chat.threadRef.lastAssistantText;
    if (!text) {
      void vscode.window.showInformationMessage("There is no assistant message to copy yet.");
      return;
    }
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage("Copied the last response.");
  });

  register("opencode.chat.clearHistory", async () => {
    const answer = await vscode.window.showWarningMessage(
      "Clear the chat shown in the panel? The OpenCode session itself is also removed.",
      { modal: true },
      "Clear",
    );
    if (answer !== "Clear") {
      return;
    }
    await run(() => chat.newChat());
    await context.globalState.update(SESSION_KEY, undefined);
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

async function run(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const text = describeError(error);
    log.error("command failed: %s", text);
    void vscode.window.showErrorMessage(text);
  }
}

function activeEditorContext(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const relative = vscode.workspace.asRelativePath(editor.document.uri);
  const selection = editor.selection;
  if (selection.isEmpty) {
    return `File \`${relative}\` (lines ${selection.start.line + 1}-${selection.end.line + 1})`;
  }
  const text = editor.document.getText(selection);
  return `File \`${relative}\`, lines ${selection.start.line + 1}-${selection.end.line + 1}:\n\n\`\`\`\n${text}\n\`\`\``;
}

function firstWorkspacePath(context: vscode.ExtensionContext): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    return folder.uri.fsPath;
  }
  // ACP requires an absolute `cwd`; fall back to the extension install path so
  // the agent still starts outside a workspace.
  return context.extensionUri.fsPath;
}

/**
 * Asks which file to attach when no editor holds the focus.
 *
 * Open tabs come first because they are what the user was just looking at;
 * workspace files are the fallback so the attach button still does something
 * in a window where nothing has been opened yet. Returns `undefined` when the
 * user cancels, or when there is nothing at all to pick.
 */
async function pickFileToAttach(): Promise<vscode.Uri | undefined> {
  const open = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .map((tab) => (tab.input instanceof vscode.TabInputText ? tab.input.uri : undefined))
    .filter((uri): uri is vscode.Uri => !!uri);

  const candidates = open.length
    ? open
    : await vscode.workspace.findFiles(WORKSPACE_FILE_GLOB, WORKSPACE_FILE_EXCLUDE, ATTACH_PICKER_LIMIT);

  const unique: vscode.Uri[] = [];
  const seen = new Set<string>();
  for (const uri of candidates) {
    const key = uri.toString();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(uri);
    }
  }

  if (!unique.length) {
    void vscode.window.showInformationMessage(
      "There is no file to attach yet. Open a file, or add a folder to the workspace, and try again.",
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    unique.map((uri) => ({ label: fileName(uri), description: vscode.workspace.asRelativePath(uri), uri })),
    { title: "Attach a file to the chat", placeHolder: "Pick the file OpenCode should talk about" },
  );
  return picked?.uri;
}

function fileName(uri: vscode.Uri): string {
  return uri.path.split("/").filter(Boolean).pop() ?? uri.path;
}

/** Remembers the open chat so it can be reopened with the workspace. */
let rememberedSessionId: string | undefined;

function syncSessionPersistence(context: vscode.ExtensionContext, chat: ChatSession | undefined): void {
  const sessionId = chat?.snapshot().session?.sessionId;
  if (sessionId === rememberedSessionId) {
    return;
  }
  rememberedSessionId = sessionId;
  void context.globalState.update(sessionKey(), sessionId);
}

let lastBusy: boolean | undefined;
let lastHasResponse: boolean | undefined;
let lastNeedsAuth: boolean | undefined;

function syncCommandContexts(chat: ChatSession | undefined): void {
  if (!chat) {
    return;
  }
  const busy = chat.isBusy;
  if (busy !== lastBusy) {
    lastBusy = busy;
    void vscode.commands.executeCommand("setContext", "opencode.busy", busy);
  }
  const hasResponse = Boolean(chat.threadRef.lastAssistantText);
  if (hasResponse !== lastHasResponse) {
    lastHasResponse = hasResponse;
    void vscode.commands.executeCommand("setContext", "opencode.hasResponse", hasResponse);
  }
  // Signing in is the only fix a failed turn can offer, so the command becomes a
  // real toolbar button while it is the action the user needs.
  const needsAuth = chat.needsAuth;
  if (needsAuth !== lastNeedsAuth) {
    lastNeedsAuth = needsAuth;
    void vscode.commands.executeCommand("setContext", "opencode.needsAuth", needsAuth);
  }
}

function sessionKey(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? `${SESSION_KEY}:${folder.uri.toString()}` : SESSION_KEY;
}

function readLastSession(context: vscode.ExtensionContext): string | undefined {
  if (!readSettings().reuseLastSession) {
    return undefined;
  }
  const value = context.globalState.get<unknown>(sessionKey());
  return typeof value === "string" ? value : undefined;
}

async function restartForWorkspace(): Promise<void> {
  if (!session) {
    return;
  }
  try {
    await session.newChat();
  } catch (error) {
    log.warn("could not switch workspace: %s", describeError(error));
  }
}

function relativeTime(value?: string | null): string {
  if (!value) {
    return "";
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    return "";
  }
  const delta = Date.now() - time;
  const minutes = Math.round(delta / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(time).toLocaleDateString();
}