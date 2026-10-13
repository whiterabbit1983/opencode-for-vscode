import type {
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionConfigSelectOptions,
  SessionInfo,
  SessionModeState,
  SessionNotification,
  WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";

import {
  isTerminalAuthMethod,
  type AgentStatus,
  OpenCodeAgent,
  toAgentError,
} from "../agent/opencode-agent.js";
import { readSettings } from "../config.js";
import { describeError, log } from "../logger.js";
import type {
  Block,
  ChatState,
  ConfigOptionView,
  PermissionRequest,
  Question,
  SessionSummary,
} from "../shared/protocol.js";
import { modelName } from "../shared/model-name.js";
import { chooseAutomatically, destructiveReason, sliceLines, toFormFields } from "./policy.js";
import { isReadOnlyTool, Thread, toBlock } from "./thread.js";

/** Quotes a token for the user's shell when driving the sign-in terminal. */
function quoteForShell(value: string): string {
  return /[\s"'$`\\*?()[\]{}<>|&;]/.test(value) ? `"${value.replace(/(["\\$`])/g, "\\$1")}"` : value;
}

type PendingPermission = {
  resolve(response: RequestPermissionResponse): void;
  timer?: ReturnType<typeof setTimeout>;
};

type PendingQuestion = {
  resolve(response: CreateElicitationResponse): void;
};

/**
 * Owns the conversation: the transcript, the active ACP session, and the
 * request/response cycle for permissions and questions raised by the agent.
 */
export class ChatSession implements vscode.Disposable {
  private readonly thread = new Thread();
  private agent: OpenCodeAgent;

  private sessionId?: string;
  private cwd?: string;
  private busy = false;
  private connection: ChatState["connection"] = "stopped";
  private connectionMessage?: string;
  private authRequired = false;
  private authInProgress = false;

  private modes?: ChatState["modes"];
  private configOptions: ConfigOptionView[] = [];
  private commands?: ChatState["commands"];

  private readonly permissions = new Map<string, PendingPermission>();
  private readonly questions = new Map<string, PendingQuestion>();
  private counter = 0;

  private readonly onChanged = new vscode.EventEmitter<void>();
  readonly changed = this.onChanged.event;

  private readonly onTranscriptChanged = new vscode.EventEmitter<void>();
  readonly transcriptChanged = this.onTranscriptChanged.event;

  constructor(private readonly cwdForSession: (workspaceUri: vscode.Uri | undefined) => string) {
    this.agent = new OpenCodeAgent({
      sessionUpdate: (notification) => this.handleSessionUpdate(notification),
      requestPermission: (params) => this.handlePermission(params),
      createElicitation: (params) => this.handleElicitation(params),
      completeElicitation: () => {
        /* URL elicitations finish inside the browser; nothing to clean up. */
      },
      readTextFile: (params) => this.handleReadTextFile(params),
      writeTextFile: (params) => this.handleWriteTextFile(params),
    });

    this.agent.onStatusChanged((status, detail) => this.handleAgentStatus(status, detail));
  }

  dispose(): void {
    this.cancelAllPending("extension disposed");
    this.onChanged.dispose();
    this.onTranscriptChanged.dispose();
    this.agent.dispose();
  }

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */

  snapshot(): ChatState {
    const settings = readSettings();
    return {
      connection: this.connection,
      connectionMessage: this.connectionMessage,
      busy: this.busy,
      session: this.summary(),
      cwd: this.cwd,
      items: this.thread.snapshot(),
      plan: settings.showPlan ? this.thread.plan : undefined,
      modes: this.modes,
      configOptions: this.configOptions.length ? this.configOptions : undefined,
      commands: this.commands,
      model: currentModel(this.configOptions),
      usage: this.thread.usage,
      retry: this.thread.retry,
      fonts: { size: settings.fontSize },
      authInProgress: this.authInProgress,
      options: {
        showThoughts: settings.showThoughts,
        showPlan: settings.showPlan,
        diffView: settings.diffView,
        permissions: settings.permissions,
        maxToolOutputLines: settings.maxToolOutputLines,
        confirmDestructiveCommands: settings.confirmDestructiveCommands,
      },
    };
  }

  get isBusy(): boolean {
    return this.busy;
  }

  get needsAuth(): boolean {
    return this.authRequired;
  }

  get threadRef(): Thread {
    return this.thread;
  }

  private summary(): SessionSummary | undefined {
    if (!this.sessionId) {
      return undefined;
    }
    return { sessionId: this.sessionId, cwd: this.cwd ?? "", title: this.sessionTitle };
  }

  private sessionTitle?: string;

  private touch(): void {
    this.onChanged.fire();
  }

  private touchTranscript(): void {
    this.onTranscriptChanged.fire();
  }

  /* ---------------------------------------------------------------- */
  /* Agent lifecycle                                                   */
  /* ---------------------------------------------------------------- */

  private handleAgentStatus(status: AgentStatus, detail?: string): void {
    switch (status) {
      case "ready":
        this.connection = "ready";
        this.connectionMessage = undefined;
        break;
      case "starting":
        this.connection = "starting";
        this.connectionMessage = undefined;
        break;
      case "error":
      case "stopped":
        // The agent is gone, so nothing will answer these. Settle them now
        // instead of leaving the user staring at a prompt that does nothing.
        this.cancelAllPending(`agent ${status}`);
        this.connection = status === "error" ? "error" : "stopped";
        this.connectionMessage = detail;
        this.busy = false;
        this.thread.closeMessage();
        break;
    }
    this.touch();
    this.touchTranscript();
  }

  async start(workspaceUri: vscode.Uri | undefined, preferredSessionId?: string): Promise<void> {
    const cwd = this.cwdForSession(workspaceUri);
    const cwdChanged = this.cwd !== undefined && this.cwd !== cwd;
    this.cwd = cwd;

    try {
      await this.agent.ensureStarted();
      this.connection = "ready";
    } catch (error) {
      const agentError = toAgentError(error);
      this.authRequired = agentError.authRequired;
      this.connection = "error";
      this.connectionMessage = agentError.message;
      this.touch();
      throw agentError;
    }

    try {
      if (preferredSessionId) {
        await this.restore(preferredSessionId, cwd);
      } else if (!this.sessionId || cwdChanged) {
        // A session belongs to the directory it was created in, so a workspace
        // switch starts a fresh conversation.
        await this.createSession(cwd);
      }
      this.authRequired = false;
      this.touch();
    } catch (error) {
      const agentError = toAgentError(error);
      this.authRequired = agentError.authRequired;
      this.connectionMessage = agentError.message;
      this.touch();
      throw agentError;
    }
  }

  private async createSession(cwd: string): Promise<void> {
    // Clear the transcript before the agent starts replaying anything.
    this.thread.reset();
    this.modes = undefined;
    this.configOptions = [];
    this.commands = undefined;
    this.sessionTitle = undefined;
    this.emitTranscript();

    const response = await this.agent.newSession(cwd);
    this.sessionId = response.sessionId;
    this.cwd = cwd;
    this.modes = toModes(response.modes);
    this.configOptions = toConfigOptions(response.configOptions);
    this.emitTranscript();
  }

  private async restore(sessionId: string, cwd: string): Promise<void> {
    const previous = this.sessionId;
    if (previous && previous !== sessionId) {
      await this.agent.closeSession(previous).catch(() => undefined);
    }
    this.thread.reset();
    this.modes = undefined;
    this.configOptions = [];
    this.commands = undefined;
    this.sessionTitle = undefined;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.emitTranscript();

    try {
      const response = await this.agent.loadSession(sessionId, cwd);
      this.modes = toModes(response.modes);
      this.configOptions = toConfigOptions(response.configOptions);
    } catch (error) {
      const agentError = toAgentError(error);
      if (agentError.authRequired) {
        this.sessionId = undefined;
        throw agentError;
      }
      // A session that no longer exists: fall back to a fresh conversation.
      log.warn("could not restore session %s: %s", sessionId, agentError.message);
      this.thread.reset();
      this.sessionId = undefined;
      await this.createSession(cwd);
      this.thread.addNotice("info", "Previous chat could not be restored", "Starting a new conversation instead.");
    }
  }

  async restart(): Promise<void> {
    this.cancelAllPending("agent restarted");
    this.busy = false;
    const sessionId = this.sessionId;
    await this.agent.restart();
    await this.start(vscode.Uri.file(this.cwd ?? process.cwd()), sessionId);
  }

  async runSignIn(): Promise<void> {
    const settings = readSettings();
    const terminalMethod = this.agent.authMethods.find(isTerminalAuthMethod);
    const args = terminalMethod?.args ?? ["auth", "login"];

    this.authInProgress = true;
    this.touch();

    const terminal = vscode.window.createTerminal({
      name: "OpenCode Sign In",
      cwd: this.cwd,
    });
    terminal.show();
    // `opencode acp --login` runs the interactive sign-in flow and exits. VS
    // Code renders the output in its own terminal, so nothing leaks into the
    // chat and no console is embedded in the extension.
    const command = [settings.binaryPath, ...args].map(quoteForShell).join(" ");
    terminal.sendText(command);

    const result = await vscode.window.showInformationMessage(
      "A sign-in terminal opened. Finish the login there, then resend your message.",
      "Restart agent",
      "Dismiss",
    );
    if (result === "Restart agent") {
      await this.restart().catch((error) => {
        void vscode.window.showErrorMessage(`Could not restart OpenCode: ${describeError(error)}`);
      });
    }
    this.authInProgress = false;
    this.touch();
  }

  /* ---------------------------------------------------------------- */
  /* Prompting                                                         */
  /* ---------------------------------------------------------------- */

  async send(text: string, extraBlocks: Block[] = []): Promise<void> {
    if (this.busy) {
      return;
    }
    const prompt = toPromptBlocks(text, extraBlocks);
    this.thread.addUser(toUiBlocks(prompt));
    this.emitTranscript();

    if (!this.sessionId) {
      try {
        await this.start(vscode.Uri.file(this.cwd ?? process.cwd()));
      } catch (error) {
        const agentError = toAgentError(error);
        this.thread.addError(agentError.message, agentError.authRequired ? "Use Sign In from the toolbar, then resend." : undefined);
        this.emitTranscript();
        return;
      }
    }

    const sessionId = this.sessionId;
    if (!sessionId) {
      this.thread.addError("OpenCode has no open session for this folder.");
      this.emitTranscript();
      return;
    }

    this.busy = true;
    this.connection = "ready";
    this.touch();

    try {
      const response = await this.agent.prompt(sessionId, prompt);
      // The provider answered, so whatever it rejected last time — missing
      // credentials or an endpoint that was down — is settled either way.
      this.authRequired = false;
      if (response.usage) {
        this.thread.usage = {
          used: response.usage.totalTokens,
          size: this.thread.usage?.size ?? 0,
          cost: this.thread.usage?.cost,
        };
      }
      this.finishTurn();
    } catch (error) {
      const agentError = toAgentError(error);
      if (agentError.authRequired) {
        this.authRequired = true;
        this.thread.addError(
          "OpenCode could not use the model provider.",
          `${agentError.message} OpenCode reports this both when credentials are missing and when the provider cannot be reached, so sign in from the toolbar or switch to another model, then resend.`,
        );
      } else {
        this.thread.addError(agentError.message);
      }
      this.finishTurn();
      log.error("prompt failed: %s", describeError(error));
    }
  }

  /** Settles everything a completed turn can leave behind. */
  private finishTurn(): void {
    this.thread.closeMessage();
    this.thread.retry = undefined;
    // The agent rejects pending permissions when a turn ends, so answer any
    // that are still waiting on the user rather than leaving them hanging.
    this.cancelAllPending("turn finished");
    this.busy = false;
    this.emitTranscript();
    this.touch();
  }

  async cancel(): Promise<void> {
    if (!this.busy || !this.sessionId) {
      return;
    }
    await this.agent.cancel(this.sessionId).catch((error) => {
      log.warn("cancel failed: %s", describeError(error));
    });
  }

  async newChat(): Promise<void> {
    const cwd = this.cwd ?? this.cwdForSession(undefined);
    this.cancelAllPending("new chat");
    if (this.sessionId) {
      await this.agent.closeSession(this.sessionId).catch(() => undefined);
    }
    await this.createSession(cwd);
    this.touch();
  }

  async listSessions(cwd: string): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = await this.agent.listSessions(cwd, cursor);
      sessions.push(...response.sessions);
      cursor = response.nextCursor ?? undefined;
      if (!cursor) {
        break;
      }
    }
    return sessions;
  }

  async openSession(sessionId: string, cwd: string): Promise<void> {
    if (this.sessionId === sessionId) {
      return;
    }
    this.cancelAllPending("session switched");
    await this.restore(sessionId, cwd);
    this.authRequired = false;
    this.touch();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.agent.deleteSession(sessionId);
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.sessionId) {
      return;
    }
    await this.agent.setMode(this.sessionId, modeId).catch((error) => {
      log.warn("set mode failed: %s", describeError(error));
    });
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    if (!this.sessionId) {
      return;
    }
    const response = await this.agent.setConfigOption(this.sessionId, configId, value).catch((error) => {
      log.warn("set config option failed: %s", describeError(error));
      return undefined;
    });
    if (response) {
      this.configOptions = toConfigOptions(response.configOptions);
    }
    this.touch();
  }

  /* ---------------------------------------------------------------- */
  /* ACP callbacks                                                     */
  /* ---------------------------------------------------------------- */

  private handleSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;

    switch (update.sessionUpdate) {
      case "available_commands_update":
        this.commands = update.availableCommands.map((command) => ({
          name: command.name,
          description: command.description,
        }));
        this.touch();
        return;

      case "current_mode_update":
        this.modes = this.modes
          ? { ...this.modes, currentModeId: update.currentModeId }
          : { currentModeId: update.currentModeId, availableModes: [] };
        this.touch();
        return;

      case "config_option_update":
        this.configOptions = toConfigOptions(update.configOptions);
        this.touch();
        return;

      case "session_info_update":
        if (typeof update.title === "string") {
          this.sessionTitle = update.title;
          this.touch();
        }
        break;

      default:
        break;
    }

    // Everything else lands in the transcript. This runs on every streamed
    // chunk, so it only notifies the transcript listener.
    this.thread.apply(update);
    this.touchTranscript();
  }

  private async handlePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const id = `perm_${++this.counter}`;
    const settings = readSettings();

    const request: PermissionRequest = {
      requestId: id,
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? "Run this tool?",
      kind: params.toolCall.kind ?? undefined,
      name: params.toolCall.name ?? undefined,
      content: toToolContent(params.toolCall.content),
      options: params.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
    };

    const autoChoice = chooseAutomatically(request, settings.permissions, (candidate) =>
      isReadOnlyTool({ kind: candidate.kind, name: candidate.name }),
    );
    if (autoChoice) {
      log.info("auto-approving %s (%s)", request.title, autoChoice.optionId);
      return { outcome: { outcome: "selected", optionId: autoChoice.optionId } };
    }

    if (settings.confirmDestructiveCommands) {
      const reason = destructiveReason(params.toolCall);
      if (reason) {
        request.warning = reason;
      }
    }

    const promise = new Promise<RequestPermissionResponse>((resolve) => {
      const timer = setTimeout(() => {
        // Never leave the agent waiting forever for an answer.
        this.permissions.delete(id);
        resolve({ outcome: { outcome: "cancelled" } });
        this.removeItem(`permission:${id}`);
      }, 10 * 60 * 1000);
      timer.unref?.();
      this.permissions.set(id, { resolve, timer });
    });

    this.thread.add({ kind: "permission", id: `permission:${id}`, request });
    this.emitTranscript();
    this.touch();
    return promise;
  }

  private async handleElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    if (params.mode !== "form") {
      // URL elicitation needs a real browser; open it and let the agent know
      // the user was sent away.
      const href = (params as { url?: string }).url;
      if (href) {
        await vscode.env.openExternal(vscode.Uri.parse(href));
      }
      return { action: "accept" };
    }

    const id = `ask_${++this.counter}`;
    const scope = params as { toolCallId?: string };
    const question: Question = {
      requestId: id,
      message: params.message,
      fields: toFormFields((params as { requestedSchema?: unknown }).requestedSchema),
      toolCallId: scope.toolCallId,
    };

    const promise = new Promise<CreateElicitationResponse>((resolve) => {
      this.questions.set(id, { resolve });
    });

    this.thread.add({ kind: "question", id: `question:${id}`, question });
    this.emitTranscript();
    this.touch();
    return promise;
  }

  private async handleReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const uri = vscode.Uri.file(params.path);
    // Respect unsaved editor buffers so the agent never reads stale content.
    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.scheme === "file" && document.uri.fsPath === uri.fsPath,
    );
    if (open) {
      return { content: sliceLines(open.getText(), params.line, params.limit) };
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    return { content: sliceLines(new TextDecoder().decode(bytes), params.line, params.limit) };
  }

  private async handleWriteTextFile(params: WriteTextFileRequest): Promise<void> {
    const uri = vscode.Uri.file(params.path);
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(uri, encoder.encode(params.content));
  }

  /* ---------------------------------------------------------------- */
  /* User responses                                                    */
  /* ---------------------------------------------------------------- */

  respondToPermission(requestId: string, optionId?: string): void {
    const pending = this.permissions.get(requestId);
    if (!pending) {
      return;
    }
    this.permissions.delete(requestId);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    const item = this.findItem(`permission:${requestId}`);
    const label =
      item?.kind === "permission"
        ? item.request.options.find((option) => option.optionId === optionId)?.name
        : undefined;

    if (item?.kind === "permission") {
      item.resolved = optionId
        ? { outcome: "selected", optionId, label: label ?? "Approved" }
        : { outcome: "cancelled" };
    }

    pending.resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
    this.emitTranscript();
    this.touch();
  }

  respondToQuestion(
    requestId: string,
    action: "accept" | "decline" | "cancel",
    values?: Record<string, unknown>,
  ): void {
    const pending = this.questions.get(requestId);
    if (!pending) {
      return;
    }
    this.questions.delete(requestId);

    const item = this.findItem(`question:${requestId}`);
    const summary =
      action === "accept" && values
        ? Object.entries(values)
            .filter(([, value]) => value !== undefined && value !== "")
            .map(([field, value]) => `${field}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
            .join(" · ")
        : undefined;
    if (item?.kind === "question") {
      item.resolved = { action, summary: summary || undefined };
    }

    pending.resolve(
      action === "accept"
        ? { action: "accept", content: (values ?? {}) as Record<string, ElicitationContentValue> }
        : { action },
    );
    this.emitTranscript();
    this.touch();
  }

  cancelAllPending(reason: string): void {
    for (const [id, pending] of this.permissions) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.resolve({ outcome: { outcome: "cancelled" } });
      log.debug("cancelled permission %s (%s)", id, reason);
    }
    this.permissions.clear();
    for (const [id, pending] of this.questions) {
      pending.resolve({ action: "cancel" });
      log.debug("cancelled question %s (%s)", id, reason);
    }
    this.questions.clear();
  }

  /* ---------------------------------------------------------------- */
  /* Item plumbing                                                     */
  /* ---------------------------------------------------------------- */

  private findItem(id: string) {
    return this.thread.items.find((item) => item.id === id);
  }

  private removeItem(id: string): void {
    const index = this.thread.items.findIndex((item) => item.id === id);
    if (index >= 0) {
      this.thread.items.splice(index, 1);
      this.emitTranscript();
      this.touch();
    }
  }

  private emitTranscript(): void {
    this.touchTranscript();
  }
}

/* ------------------------------------------------------------------ */
/* Conversion helpers                                                   */
/* ------------------------------------------------------------------ */

function toUiBlocks(blocks: ContentBlock[]): Block[] {
  const result: Block[] = [];
  for (const block of blocks) {
    const converted = toBlock(block);
    if (converted) {
      result.push(converted);
    }
  }
  return result;
}

function toPromptBlocks(text: string, extra: Block[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (text.trim()) {
    blocks.push({ type: "text", text });
  }
  for (const block of extra) {
    switch (block.type) {
      case "text":
        blocks.push({ type: "text", text: block.text });
        break;
      case "image":
        blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
        break;
      case "resource":
        blocks.push({
          type: "resource_link",
          uri: block.uri,
          name: block.name,
          mimeType: block.mimeType ?? null,
        });
        break;
    }
  }
  return blocks;
}

function toToolContent(content: unknown): PermissionRequest["content"] {
  if (!Array.isArray(content)) {
    return [];
  }
  const result: PermissionRequest["content"] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const item = entry as { type?: string; [key: string]: unknown };
    if (item.type === "content") {
      const block = toBlock(item.content);
      if (block?.type === "text") {
        result.push({ type: "text", text: block.text });
      }
    } else if (item.type === "diff" && typeof item.path === "string" && typeof item.newText === "string") {
      result.push({
        type: "diff",
        path: item.path,
        oldText: typeof item.oldText === "string" ? item.oldText : undefined,
        newText: item.newText,
      });
    }
  }
  return result;
}

function toModes(state?: SessionModeState | null): ChatState["modes"] {
  if (!state) {
    return undefined;
  }
  return {
    currentModeId: state.currentModeId,
    availableModes: state.availableModes.map((mode) => ({
      id: mode.id,
      name: mode.name,
      description: mode.description ?? undefined,
    })),
  };
}

function toConfigOptions(options?: SessionConfigOption[] | null): ConfigOptionView[] {
  if (!options) {
    return [];
  }
  return options.map((option) => {
    const base: ConfigOptionView = {
      id: option.id,
      name: option.name,
      type: option.type,
      category: option.category ?? undefined,
      description: option.description ?? undefined,
    };
    if (option.type === "select") {
      return {
        ...base,
        current: String(option.currentValue ?? ""),
        options: flattenSelectOptions(option.options),
      };
    }
    return { ...base, current: option.currentValue ? "true" : "false" };
  });
}

function flattenSelectOptions(
  options: SessionConfigSelectOptions,
): Array<{ value: string; label: string; description?: string }> {
  const result: Array<{ value: string; label: string; description?: string }> = [];
  for (const entry of options ?? []) {
    if (Array.isArray(entry)) {
      result.push(...flattenSelectOptions(entry as SessionConfigSelectOptions));
    } else if (entry && "options" in entry && "group" in entry) {
      result.push(
        ...entry.options.map((option) => ({
          value: option.value,
          label: option.name,
          description: option.description ?? undefined,
        })),
      );
    } else if (entry && typeof entry === "object" && "value" in entry) {
      result.push({
        value: entry.value,
        label: entry.name,
        description: entry.description ?? undefined,
      });
    }
  }
  return result;
}

function currentModel(configOptions: ConfigOptionView[]): ChatState["model"] | undefined {
  const model = configOptions.find((option) => option.id === "model" || option.category === "model");
  if (!model || !model.current) {
    return undefined;
  }
  // `opencode/cat-jam-free` is an id, not something to show a person, so the
  // name the agent ships with the option is preferred and the id is only
  // humanised when the agent has nothing better.
  const choice = model.options?.find((option) => option.value === model.current);
  return { id: model.current, name: modelName(model.current, choice?.label) };
}
