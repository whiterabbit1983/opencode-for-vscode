import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  AGENT_METHODS,
  CLIENT_METHODS,
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type AuthMethod,
  type AuthenticateResponse,
  type ClientApp,
  type ClientConnection,
  type CloseSessionResponse,
  type CompleteElicitationNotification,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type DeleteSessionResponse,
  type ListSessionsResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type SessionNotification,
  type SetSessionConfigOptionResponse,
  type SetSessionModeResponse,
  type WriteTextFileRequest,
} from "@agentclientprotocol/sdk";

import { readSettings } from "../config.js";
import { describeError, log } from "../logger.js";
import { EXTENSION_VERSION } from "../version.js";

/** Callbacks the UI layer implements. Everything ACP-specific is funnelled here. */
export interface AgentHost {
  sessionUpdate(notification: SessionNotification): void;
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
  completeElicitation(notification: CompleteElicitationNotification): void;
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(params: WriteTextFileRequest): Promise<void>;
}

/** Narrowing helper for the terminal flavour of ACP auth methods. */
export function isTerminalAuthMethod(
  method: AuthMethod,
): method is AuthMethod & { type: "terminal"; args?: string[] } {
  return (method as { type?: string }).type === "terminal";
}

export type AgentStatus = "stopped" | "starting" | "ready" | "error";

export class AgentError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly authRequired = false,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

const AUTH_REQUIRED = -32000;

/**
 * How long to wait for the agent to answer the ACP handshake before giving up.
 * A wedged agent should produce an error the user can act on, not a spinner
 * that never resolves.
 */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** How long session bookkeeping calls (new/list/delete/resume) may take. */
const SESSION_TIMEOUT_MS = 20_000;

/**
 * Rejects with `message` if `promise` has not settled within `timeoutMs`.
 *
 * The underlying request is not cancelled — ACP has no cancellation for
 * fire-and-forget control calls — but the caller stops waiting on it, and the
 * agent process is torn down by the caller's error handling.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AgentError(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * A handle that can be disposed. Declared here rather than imported from
 * `vscode` so this layer stays free of editor APIs and can be exercised by the
 * smoke test outside a running extension host.
 */
export class Disposable {
  constructor(private readonly callOnDispose: () => void = () => undefined) {}

  dispose(): void {
    this.callOnDispose();
  }
}

/**
 * Owns the `opencode acp` child process and the ACP client connection to it.
 *
 * One agent process serves every session in the extension, so switching chats
 * reuses the running process instead of paying startup cost again.
 */
export class OpenCodeAgent {
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientConnection;
  private app?: ClientApp;
  private status: AgentStatus = "stopped";
  private startPromise?: Promise<void>;
  private disposed = false;
  private stderrTail: string[] = [];

  agentInfo?: { name: string; version: string; title?: string };
  agentCapabilities?: AgentCapabilities;
  authMethods: AuthMethod[] = [];
  protocolVersion?: number;

  constructor(private readonly host: AgentHost) {}

  get isReady(): boolean {
    return this.status === "ready";
  }

  get currentStatus(): AgentStatus {
    return this.status;
  }

  onStatusChanged(listener: (status: AgentStatus, detail?: string) => void): Disposable {
    this.statusListeners.push(listener);
    return new Disposable(() => {
      this.statusListeners = this.statusListeners.filter((entry) => entry !== listener);
    });
  }

  private statusListeners: Array<(status: AgentStatus, detail?: string) => void> = [];

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  async ensureStarted(): Promise<void> {
    if (this.status === "ready") {
      return;
    }
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = undefined;
      });
    }
    await this.startPromise;
  }

  private async start(): Promise<void> {
    this.setStatus("starting");
    const settings = readSettings();
    const args = [...settings.extraArgs, "acp"];

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(settings.binaryPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...settings.env },
        windowsHide: true,
      });
    } catch (error) {
      this.setStatus("error", describeError(error));
      throw this.wrapStartupError(error);
    }

    this.child = child;
    this.stderrTail = [];

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.onStderr(chunk));

    child.on("exit", (code, signal) => this.onExit(code, signal));
    child.on("error", (error) => {
      log.error("child process error: %s", describeError(error));
    });

    // NOTE: stdout must stay binary. `Readable.toWeb()` forwards whatever the
    // Node stream emits, and setting an encoding makes it emit strings, which
    // `ndJsonStream` cannot decode — the agent then never sees a line and
    // `initialize` hangs forever. Only stderr may be decoded to a string.
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );

    this.app = client({ name: "opencode-vscode" })
      .onNotification(CLIENT_METHODS.session_update, (context) => {
        this.host.sessionUpdate(context.params);
      })
      .onRequest(CLIENT_METHODS.session_request_permission, async (context) => {
        return this.host.requestPermission(context.params);
      })
      .onRequest(CLIENT_METHODS.elicitation_create, async (context) => {
        return this.host.createElicitation(context.params);
      })
      .onNotification(CLIENT_METHODS.elicitation_complete, (context) => {
        this.host.completeElicitation(context.params);
      })
      .onRequest(CLIENT_METHODS.fs_read_text_file, async (context) => {
        return this.host.readTextFile(context.params);
      })
      .onRequest(CLIENT_METHODS.fs_write_text_file, async (context) => {
        await this.host.writeTextFile(context.params);
      });

    this.connection = this.app.connect(stream);

    try {
      const response = await withTimeout(
        this.connection.agent.request(AGENT_METHODS.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "opencode-vscode", version: EXTENSION_VERSION, title: "OpenCode for VS Code" },
          clientCapabilities: {
            // Terminals are deliberately not advertised: OpenCode runs its own
            // shell tool, so the chat never has to render a console.
            terminal: false,
            fs: { readTextFile: true, writeTextFile: true },
            session: { compaction: {}, configOptions: {}, notices: {} },
            auth: { terminal: true },
            elicitation: { form: {} },
            _meta: { "terminal-auth": true },
          },
        }),
        HANDSHAKE_TIMEOUT_MS,
        `OpenCode did not answer \`initialize\` within ${HANDSHAKE_TIMEOUT_MS / 1000}s.`,
      );

      this.protocolVersion = response.protocolVersion;
      this.agentCapabilities = response.agentCapabilities ?? {};
      this.authMethods = response.authMethods ?? [];
      this.agentInfo = response.agentInfo
        ? { name: response.agentInfo.name, version: response.agentInfo.version, title: response.agentInfo.title ?? undefined }
        : undefined;

      if (response.protocolVersion !== PROTOCOL_VERSION) {
        log.warn("agent negotiated protocol version %s, client speaks %s", response.protocolVersion, PROTOCOL_VERSION);
      }

      this.setStatus("ready");
      log.info("connected to opencode %s (protocol v%s)", this.agentInfo?.version ?? "?", this.protocolVersion);
    } catch (error) {
      await this.terminateChild();
      const message = describeError(error);
      this.setStatus("error", message);
      throw this.wrapStartupError(error, message);
    }
  }

  private onStderr(chunk: string): void {
    // Kept for diagnostics only; the chat UI never shows raw agent logs.
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      log.raw(`[opencode] ${line}`);
      this.stderrTail.push(line);
      if (this.stderrTail.length > 40) {
        this.stderrTail.shift();
      }
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.disposed) {
      return;
    }
    const detail =
      code === 0
        ? undefined
        : `opencode exited with ${signal ? `signal ${signal}` : `code ${code}`}${this.stderrTail.length ? `: ${this.stderrTail[this.stderrTail.length - 1]}` : ""}`;
    this.child = undefined;
    this.connection = undefined;
    this.setStatus("error", detail);
    log.warn("opencode acp process exited (code=%s signal=%s)", code, signal);
  }

  private setStatus(status: AgentStatus, detail?: string): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      try {
        listener(status, detail);
      } catch (error) {
        log.error("status listener failed: %s", describeError(error));
      }
    }
  }

  private wrapStartupError(error: unknown, message?: string): AgentError {
    const text = message ?? describeError(error);
    if (/ENOENT|not found|command not found/i.test(text)) {
      const settings = readSettings();
      return new AgentError(
        `Could not run \`${settings.binaryPath}\`. Install OpenCode or set \`opencode.binaryPath\` to the absolute path printed by \`which opencode\`.`,
        undefined,
        false,
      );
    }
    return toAgentError(error);
  }

  /* ---------------------------------------------------------------- */
  /* ACP calls                                                         */
  /* ---------------------------------------------------------------- */

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    await this.ensureStarted();
    if (!this.connection) {
      throw new AgentError("The OpenCode agent is not running.");
    }
    try {
      return (await this.connection.agent.request(method as never, params as never)) as T;
    } catch (error) {
      throw toAgentError(error);
    }
  }

  /**
   * Same as {@link call}, but gives up after `timeoutMs`. Used for requests
   * that must complete promptly — creating, loading and listing sessions — so a
   * wedged agent surfaces as an error instead of an eternal spinner.
   *
   * `session/prompt` is deliberately *not* wrapped: a turn can legitimately run
   * for many minutes.
   */
  private async callWithTimeout<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    await this.ensureStarted();
    if (!this.connection) {
      throw new AgentError("The OpenCode agent is not running.");
    }
    try {
      return (await withTimeout(
        this.connection.agent.request(method as never, params as never),
        timeoutMs,
        `OpenCode did not answer \`${method}\` within ${Math.round(timeoutMs / 1000)}s.`,
      )) as T;
    } catch (error) {
      throw toAgentError(error);
    }
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (!this.connection) {
      return;
    }
    try {
      await this.connection.agent.notify(method as never, params as never);
    } catch (error) {
      log.warn("notification %s failed: %s", method, describeError(error));
    }
  }

  async newSession(cwd: string): Promise<NewSessionResponse> {
    const response = await this.callWithTimeout<NewSessionResponse>(
      AGENT_METHODS.session_new,
      { cwd, mcpServers: [] },
      SESSION_TIMEOUT_MS,
    );
    log.info("created session %s in %s", response.sessionId, cwd);
    return response;
  }

  async loadSession(sessionId: string, cwd: string): Promise<LoadSessionResponse> {
    return this.callWithTimeout<LoadSessionResponse>(
      AGENT_METHODS.session_load,
      { sessionId, cwd, mcpServers: [] },
      // Replaying a long transcript can take a while, so this is generous.
      SESSION_TIMEOUT_MS * 4,
    );
  }

  async resumeSession(sessionId: string, cwd: string): Promise<ResumeSessionResponse> {
    return this.callWithTimeout<ResumeSessionResponse>(
      AGENT_METHODS.session_resume,
      { sessionId, cwd, mcpServers: [] },
      SESSION_TIMEOUT_MS,
    );
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.call<CloseSessionResponse | void>(AGENT_METHODS.session_close, { sessionId }).catch(
      (error) => {
        log.warn("session/close failed: %s", describeError(error));
      },
    );
  }

  async listSessions(cwd: string, cursor?: string): Promise<ListSessionsResponse> {
    return this.callWithTimeout<ListSessionsResponse>(
      AGENT_METHODS.session_list,
      { cwd, cursor: cursor ?? null },
      SESSION_TIMEOUT_MS,
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.callWithTimeout<DeleteSessionResponse | void>(
      AGENT_METHODS.session_delete,
      { sessionId },
      SESSION_TIMEOUT_MS,
    );
  }

  async prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse> {
    return this.call<PromptResponse>(AGENT_METHODS.session_prompt, { sessionId, prompt });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.notify(AGENT_METHODS.session_cancel, { sessionId });
  }

  async setMode(sessionId: string, modeId: string): Promise<SetSessionModeResponse | void> {
    return this.call<SetSessionModeResponse | void>(AGENT_METHODS.session_set_mode, {
      sessionId,
      modeId,
    });
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<SetSessionConfigOptionResponse> {
    return this.call<SetSessionConfigOptionResponse>(AGENT_METHODS.session_set_config_option, {
      sessionId,
      configId,
      value,
    });
  }

  async authenticate(methodId: string): Promise<void> {
    await this.call<AuthenticateResponse | void>(AGENT_METHODS.authenticate, { methodId });
  }

  /* ---------------------------------------------------------------- */
  /* Restart / dispose                                                 */
  /* ---------------------------------------------------------------- */

  async restart(): Promise<void> {
    await this.terminateChild();
    this.setStatus("stopped");
    await this.ensureStarted();
  }

  private async terminateChild(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.connection?.close();
    this.connection = undefined;
    this.app = undefined;
    if (!child) {
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      child.stdin.end();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2000);
      timer.unref?.();
      child.once("exit", () => clearTimeout(timer));
    }).catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    this.statusListeners = [];
    void this.terminateChild();
  }
}

/**
 * ACP has a single code for "the provider said no", `-32000`, and OpenCode
 * folds every internal `AI.Error.Authentication` into it. That includes an
 * upstream that is merely *unreachable* (`Upstream request failed: Endpoint is
 * unavailable`), not just absent credentials. So the flag is a hint, not a
 * verdict: the agent's own wording is kept as the error text, because it is the
 * only thing that reaches us, and replacing it with a fixed "sign in" sentence
 * hides the difference between the two cases.
 */
export function toAgentError(error: unknown): AgentError {
  if (error instanceof AgentError) {
    return error;
  }
  const message = describeError(error);
  const code = extractCode(error);
  if (code === AUTH_REQUIRED || /auth_required/i.test(message)) {
    return new AgentError(message, code, true);
  }
  return new AgentError(message, code);
}

function extractCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const candidate = error as { code?: unknown; data?: { code?: unknown } };
  if (typeof candidate.code === "number") {
    return candidate.code;
  }
  if (candidate.data && typeof candidate.data.code === "number") {
    return candidate.data.code;
  }
  return undefined;
}