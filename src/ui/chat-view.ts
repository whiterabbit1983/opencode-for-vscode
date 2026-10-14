import * as vscode from "vscode";

import type { ChatSession } from "../session/chat-session.js";
import { describeError, log } from "../logger.js";
import type { ChatState, HostMessage, WebviewMessage } from "../shared/protocol.js";
import { EXTENSION_VERSION } from "../version.js";
import type { DiffPreviewProvider } from "./diff-preview.js";
import { FileIndex } from "./file-search.js";

export interface ChatViewOptions {
  /** Session to restore when the agent is started for the first time. */
  lastSessionId?: () => string | undefined;
}

/** Upper bound on transcript messages per second, roughly one per frame. */
const TRANSCRIPT_COALESCE_MS = 50;

/**
 * Bridges the chat webview to the session.
 *
 * The same instance backs both the activity-bar view and the optional editor
 * tab, so a chat can be moved between the two without losing state.
 */
export class ChatViewHost implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencode.chat";

  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private readonly files = new FileIndex();
  private viewReady = false;
  private panelReady = false;
  private started = false;
  private starting?: Promise<void>;
  private transcriptTimer?: ReturnType<typeof setTimeout>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly session: ChatSession,
    private readonly diffs: DiffPreviewProvider,
    private readonly options: ChatViewOptions = {},
  ) {
    // `changed` carries connection, session and agent state and fires rarely.
    // `transcriptChanged` fires on every streamed chunk, so it sends only the
    // parts of the transcript that actually move.
    this.disposables.push(
      this.session.changed(() => this.pushState()),
      this.session.transcriptChanged(() => this.pushTranscript()),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = this.webviewOptions();
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((message: WebviewMessage) => this.handle(message, view.webview));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.ensureStarted();
      }
    });
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.viewReady = false;
      }
    });

    this.disposables.push(
      vscode.window.onDidChangeActiveColorTheme(() => this.pushState()),
      this.session.changed(() => {
        void vscode.commands.executeCommand("setContext", "opencode.busy", this.session.isBusy);
      }),
    );

    void this.ensureStarted();
  }

  /* ---------------------------------------------------------------- */
  /* Editor tab                                                        */
  /* ---------------------------------------------------------------- */

  async openInEditor(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "opencode.chat.editor",
      "OpenCode",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      this.webviewOptions(),
    );
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "resources", "activity-bar.svg");
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((message: WebviewMessage) => this.handle(message, panel.webview));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.panelReady = false;
    });
    void this.ensureStarted();
  }

  /* ---------------------------------------------------------------- */
  /* Messaging                                                         */
  /* ---------------------------------------------------------------- */

  private eachWebview(visitor: (webview: vscode.Webview) => void): void {
    if (this.view && this.viewReady) {
      visitor(this.view.webview);
    }
    if (this.panel && this.panelReady) {
      visitor(this.panel.webview);
    }
  }

  private post(message: HostMessage): void {
    this.eachWebview((webview) => void webview.postMessage(message));
  }

  pushState(): void {
    this.post({ type: "state", state: this.session.snapshot() });
  }

  /**
   * Sends only the transcript, coalesced to at most one message per frame
   * window. The agent can stream faster than a webview can paint, and there is
   * no point serialising a turn that is already superseded.
   */
  private pushTranscript(): void {
    if (this.transcriptTimer) {
      return;
    }
    this.transcriptTimer = setTimeout(() => {
      this.transcriptTimer = undefined;
      const snapshot = this.session.snapshot();
      this.post({
        type: "patch",
        items: snapshot.items,
        plan: snapshot.plan,
        usage: snapshot.usage,
        retry: snapshot.retry,
      });
    }, TRANSCRIPT_COALESCE_MS);
    this.transcriptTimer.unref?.();
  }

  toast(level: "info" | "warn" | "error", message: string): void {
    this.post({ type: "toast", level, message });
  }

  submitDraft(text: string): void {
    this.post({ type: "submitDraft", text });
  }

  insertDraft(text: string): void {
    this.post({ type: "insertDraft", text });
  }

  focusInput(): void {
    this.post({ type: "focusInput" });
  }

  /* ---------------------------------------------------------------- */
  /* Commands from the webview                                         */
  /* ---------------------------------------------------------------- */

  private async handle(message: WebviewMessage, webview: vscode.Webview): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          if (webview === this.view?.webview) {
            this.viewReady = true;
          }
          if (webview === this.panel?.webview) {
            this.panelReady = true;
          }
          this.pushState();
          await this.ensureStarted();
          return;

        case "send":
          await this.session.send(message.text, message.blocks);
          return;

        case "cancel":
          await this.session.cancel();
          return;

        case "newSession":
          await this.guard(() => this.session.newChat());
          return;

        case "retryAgent":
          await this.guard(() => this.session.restart());
          return;

        case "openSession": {
          const cwd = this.session.snapshot().cwd ?? process.cwd();
          await this.guard(() => this.session.openSession(message.sessionId, cwd));
          return;
        }

        case "deleteSession":
          await this.guard(() => this.session.deleteSession(message.sessionId));
          return;

        case "respondPermission":
          this.session.respondToPermission(message.requestId, message.optionId);
          return;

        case "respondQuestion":
          this.session.respondToQuestion(message.requestId, message.action, message.values);
          return;

        case "setMode":
          await this.session.setMode(message.modeId);
          return;

        case "setConfigOption":
          await this.session.setConfigOption(message.configId, message.value);
          return;

        case "searchFiles": {
          const files = await this.files.search(message.query);
          this.post({ type: "fileResults", requestId: message.requestId, files });
          return;
        }

        case "openFile":
          await this.openFile(message.path, message.line);
          return;

        case "openDiff":
          this.diffs.open(message.oldText || null, message.newText, message.path, crypto.randomUUID());
          return;

        case "openLink":
          await this.openLink(message.href);
          return;

        case "signIn":
          await this.guard(() => this.session.runSignIn());
          return;

        case "showLog":
          log.show();
          return;

        case "runCommand":
          await vscode.commands.executeCommand(message.command);
          return;

        case "copyText":
          await vscode.env.clipboard.writeText(message.text);
          return;

        case "log":
          log[message.level](`[webview] ${message.message}`);
          return;

        default:
          return;
      }
    } catch (error) {
      const text = describeError(error);
      log.error("webview command %s failed: %s", (message as { type: string }).type, text);
      this.toast("error", text);
    }
  }

  private async guard(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      const text = describeError(error);
      log.warn("command failed: %s", text);
      this.toast("error", text);
    }
  }

  private async openFile(path: string, line?: number): Promise<void> {
    const uri = vscode.Uri.file(path);
    const document = await vscode.workspace.openTextDocument(uri);
    const selection = line
      ? new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0)
      : undefined;
    await vscode.window.showTextDocument(document, {
      preview: true,
      selection,
      preserveFocus: false,
    });
  }

  private async openLink(href: string): Promise<void> {
    // Links inside a transcript can point at files in the workspace, VS Code
    // commands, or the web. Each is opened in the place it belongs.
    const target = /^(https?|mailto):/i.test(href)
      ? vscode.Uri.parse(href)
      : href.startsWith("command:")
        ? undefined
        : vscode.Uri.parse(href);

    if (!target) {
      await vscode.commands.executeCommand(href.slice("command:".length));
      return;
    }
    if (target.scheme === "file") {
      await this.openFile(target.fsPath);
      return;
    }
    if (target.scheme === "vscode") {
      await vscode.commands.executeCommand("vscode.open", target);
      return;
    }
    await vscode.env.openExternal(target);
  }

  async ensureStarted(): Promise<void> {
    if (this.started && this.session.snapshot().connection === "ready") {
      return;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.doStart().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    try {
      // A freshly opened extension window always starts a new conversation;
      // charts can still be resumed explicitly from history.
      void this.options.lastSessionId;
      const restore = undefined;
      await this.session.start(vscode.workspace.workspaceFolders?.[0]?.uri, restore);
      this.started = true;
    } catch (error) {
      const text = describeError(error);
      log.warn("agent start failed: %s", text);
      this.toast("error", text);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Webview plumbing                                                  */
  /* ---------------------------------------------------------------- */

  private webviewOptions(): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.Uri.joinPath(this.extensionUri, "media"),
      ],
      retainContextWhenHidden: true,
    };
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.css"));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "codicon.css"));
    const nonce = makeNonce();

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource};" />
    <link href="${codiconUri}" rel="stylesheet" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>OpenCode</title>
  </head>
  <body data-version="${EXTENSION_VERSION}">
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  dispose(): void {
    if (this.transcriptTimer) {
      clearTimeout(this.transcriptTimer);
      this.transcriptTimer = undefined;
    }
    this.files.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

function makeNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i++) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

export type { ChatState };