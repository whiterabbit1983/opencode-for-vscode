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
import { isPersistable, mergeUsage, noUsageMemory, type Usage, type UsageMemory } from "../shared/usage.js";
import { modelToRestore, noModelMemory, type ModelMemory } from "./model-memory.js";
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
 * A prompt waiting behind a running turn.
 *
 * There is no transcript item yet: the message joins the transcript at the
 * moment it starts running, which is where it belongs chronologically and
 * keeps a queued prompt from looking like something the agent already has.
 */
type QueuedPrompt = {
  id: string;
  prompt: ContentBlock[];
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
  private readonly queuedPrompts: QueuedPrompt[] = [];
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
  /** Ids for the composer queue, which has no transcript item to borrow from. */
  private queueSeq = 0;

  private readonly onChanged = new vscode.EventEmitter<void>();
  readonly changed = this.onChanged.event;

  private readonly onTranscriptChanged = new vscode.EventEmitter<void>();
  readonly transcriptChanged = this.onTranscriptChanged.event;

  constructor(
    private readonly cwdForSession: (workspaceUri: vscode.Uri | undefined) => string,
    private readonly modelMemory: ModelMemory = noModelMemory(),
    private readonly usageMemory: UsageMemory = noUsageMemory(),
  ) {
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
      queue: this.queueView(),
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
        this.dropQueuedPrompts(`OpenCode ${status === "error" ? "failed" : "stopped"} before these were sent.`);
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
    this.seedUsage();
    await this.applyRememberedModel();
    this.emitTranscript();
  }

  /**
   * Puts a fresh session back on the model the user last chose.
   *
   * Only fresh sessions get this treatment: a resumed conversation already
   * carries the model it was created with, and rewriting it would be
   * surprising.
   */
  private async applyRememberedModel(): Promise<void> {
    const restore = modelToRestore(this.configOptions, this.modelMemory.read());
    if (!restore) {
      return;
    }
    log.info("restoring remembered model %s", restore.value);
    await this.setConfigOption(restore.configId, restore.value);
  }

  /**
   * Puts the last known context reading back on the status bar.
   *
   * Neither `session/new` nor `session/load` reports usage, so a chat opened
   * at rest would otherwise show nothing at all until a turn streamed an
   * update. The figures are deliberately not marked as live: the next
   * `usage_update` overwrites them, and until then they are the honest
   * "as of the end of the last turn" reading.
   */
  private seedUsage(): void {
    const remembered = this.usageMemory.read();
    if (!isPersistable(remembered)) {
      return;
    }
    this.thread.usage = remembered;
    this.persistedUsage = remembered;
  }

  /**
   * Writes the reading out so the next chat has something to seed from.
   *
   * Guarded on identity because a turn streams a `usage_update` per chunk, and
   * `usage_update` is the only place cost arrives, so most of them would be
   * the same write.
   */
  private persistUsage(): void {
    const usage = this.thread.usage;
    if (!isPersistable(usage) || usage === this.persistedUsage) {
      return;
    }
    this.persistedUsage = usage;
    this.usageMemory.write(usage);
  }

  /** The reading last written out, so an unchanged one is not rewritten. */
  private persistedUsage?: Usage;

  /**
   * The composer queue as the UI sees it.
   *
   * Empty is left out rather than sent as an empty list, so the strip can hide
   * itself without having to count anything.
   */
  private queueView(): ChatState["queue"] {
    if (!this.queuedPrompts.length) {
      return undefined;
    }
    return this.queuedPrompts.map((entry) => ({
      id: entry.id,
      preview: promptPreview(entry.prompt),
      blocks: toUiBlocks(entry.prompt),
    }));
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
    this.seedUsage();
    this.emitTranscript();

    try {
      const response = await this.agent.loadSession(sessionId, cwd);
      this.modes = toModes(response.modes);
      this.configOptions = toConfigOptions(response.configOptions);
      // The loaded session may use a different model/mode/effort than the one
      // that was active before, so publish the restored config right away.
      this.touch();
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
    this.dropQueuedPrompts("The agent restarted before these were sent.");
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
    const prompt = toPromptBlocks(text, extraBlocks);

    if (this.busy) {
      // OpenCode is still working, so the prompt waits in the queue above the
      // composer instead of being dropped or shown as though it were answered.
      this.queuedPrompts.push({ id: `queued-${++this.queueSeq}`, prompt });
      this.emitTranscript();
      this.touch();
      return;
    }

    this.thread.addUser(toUiBlocks(prompt));
    this.emitTranscript();
    await this.runPrompt(prompt);
  }

  /** Runs a single prompt. The user message is assumed to be rendered already. */
  private async runPrompt(prompt: ContentBlock[]): Promise<void> {
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
        // A seeded reading is not evidence about this turn, so only what the
        // agent actually streamed may suppress the session total.
        this.thread.usage = mergeUsage(this.thread.liveUsage, {
          totalTokens: response.usage.totalTokens,
        });
        this.persistUsage();
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
      // A failed turn should not silently drain the rest of the queue.
      this.dropQueuedPrompts("This turn failed before the queue could run.");
      return;
    }

    // Drain any queued follow-up prompts one at a time.
    if (this.queuedPrompts.length && !this.busy) {
      const next = this.queuedPrompts.shift()!;
      // The message only enters the transcript now, as it starts running, so
      // it lands after the answer it was a follow-up to.
      this.thread.addUser(toUiBlocks(next.prompt));
      this.emitTranscript();
      this.touch();
      await this.runPrompt(next.prompt);
    }
  }

  /**
   * Discards everything still waiting.
   *
   * The messages never entered the transcript, so they are added now — marked
   * dropped rather than deleted, because the user did type them and losing the
   * text would be worse than showing it as unsent.
   */
  private dropQueuedPrompts(reason: string): void {
    const dropped = this.queuedPrompts.splice(0, this.queuedPrompts.length);
    if (!dropped.length) {
      return;
    }
    for (const entry of dropped) {
      this.thread.addUser(toUiBlocks(entry.prompt)).status = "dropped";
    }
    this.thread.addNotice("warning", "Queued messages discarded", reason);
    this.emitTranscript();
    this.touch();
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
    this.dropQueuedPrompts("You stopped the turn before these were sent.");
    if (!this.busy || !this.sessionId) {
      return;
    }
    await this.agent.cancel(this.sessionId).catch((error) => {
      log.warn("cancel failed: %s", describeError(error));
    });
  }

  async newChat(): Promise<void> {
    this.dropQueuedPrompts("A new conversation was started before these were sent.");
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
    // The transcript is about to be wiped, so there would be nowhere to put
    // these even as unsent messages — and sending them into the conversation
    // the user just switched to would be worse than losing them.
    this.queuedPrompts.length = 0;
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
    // Only an explicit pick is remembered. The agent also pushes model changes
    // of its own accord (subagents, retries), and those are not what the user
    // would want the next new chat to start on.
    if (configId === "model" && response) {
      this.modelMemory.write(value);
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
    this.persistUsage();
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

/**
 * A one-line stand-in for a queued prompt.
 *
 * The queue strip is a list, not a transcript, so the message is flattened to
 * its first line — anything the composer held rather than typed (an image, an
 * attached file) still has to show as something, or the row reads as blank.
 */
function promptPreview(blocks: ContentBlock[]): string {
  const text = blocks
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "resource_link") {
        return block.name;
      }
      return "[image]";
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text || "[attachment]";
}

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
