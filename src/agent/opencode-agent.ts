import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
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

import { hostLabel, readSettings, type OpenCodeSettings } from "../config.js";
import { describeError, log } from "../logger.js";
import {
  candidatePaths,
  expandHome,
  isPathLike,
  parseProbe,
  shellProbes,
  type ProbeResult,
  type ShellProbe,
} from "../shared/binary.js";
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

/**
 * A started agent and the executable behind it.
 *
 * The binary is carried out of {@link OpenCodeAgent.launch} because it is not
 * always the one that was configured: a bare name can be resolved to a path, and
 * an error about "the agent died" has to name the file that actually died.
 */
type Launched = { child: ChildProcessWithoutNullStreams; binary: string };

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
 * How long one login-shell probe may take before it is abandoned.
 *
 * A profile that reaches for the network, or an rc file that prompts, can hang,
 * and a hung shell must never become a hung extension host.
 */
const LOGIN_SHELL_TIMEOUT_MS = 5_000;

/**
 * How long to wait for a process's death once its connection has already
 * closed.
 *
 * The exit follows the close within a tick or two. Anything longer than that is
 * a process that shut its streams and stayed alive, and there the transport's
 * word is the best one available.
 */
const DEATH_GRACE_MS = 1_000;

/**
 * Resolves with `undefined` after `ms`, for giving up on something without
 * rejecting because it did not happen.
 */
function settleAfter(ms: number): Promise<undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
}

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

  /**
   * What the last successful launch actually ran, so a restart does not pay for
   * the discovery again. Keyed by what the user configured: change
   * `opencode.binaryPath` and the entry no longer applies.
   */
  private resolved?: { requested: string; binary: string; envPath?: string };

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

    // A child that never spawns reports `error` asynchronously, so the spawn is
    // awaited rather than assumed. It has to be: without that a missing binary
    // produced no error at all — the handshake went unanswered, and the teardown
    // that followed waited for an `exit` that a child which never spawned
    // cannot emit, so the panel sat on *starting* forever with the only clue
    // left in the output channel.
    let launched: Launched;
    try {
      launched = await this.launch(settings, args);
    } catch (error) {
      this.setStatus("error", describeError(error));
      throw error instanceof AgentError ? error : this.wrapStartupError(error);
    }
    const { child } = launched;

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

    // Resolves when the agent is gone, and with what it said on the way out. An
    // agent that dies while introducing itself never answers, and the reason is
    // in its last words on stderr — which beats a bare "did not answer".
    const died = this.whenItDies(child, launched.binary);

    try {
      const response = await withTimeout(
        Promise.race([
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
          died.then((reason) => {
            throw reason;
          }),
        ]),
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
      const reason = await this.reasonForStartupFailure(error, died);
      await this.terminateChild();
      const message = describeError(reason);
      this.setStatus("error", message);
      throw this.wrapStartupError(reason, message);
    }
  }

  /**
   * Settles when the agent is gone, with the reason.
   *
   * Two things can end a startup: the process dying, and the transport noticing
   * that the connection closed. They are the same event seen from two sides, and
   * the transport loses the information — it can only say "closed". So the death
   * is waited out before the transport's word becomes the error the user sees.
   */
  private async reasonForStartupFailure(error: unknown, died: Promise<AgentError>): Promise<unknown> {
    // Anything other than a closed connection is the agent's own answer and is
    // more specific than a process exit would be.
    if (!/closed/i.test(describeError(error))) {
      return error;
    }
    const reason = await Promise.race([died, settleAfter(DEATH_GRACE_MS)]);
    return reason ?? error;
  }

  /** Resolves once the child has died, with why. Never rejects. */
  private whenItDies(child: ChildProcess, binary: string): Promise<AgentError> {
    return new Promise<AgentError>((resolve) => {
      child.once("error", (error) => {
        resolve(this.wrapStartupError(error));
      });
      child.once("exit", (code, signal) => {
        resolve(new AgentError(exitDetail(binary, code, signal, this.lastStderrLine())));
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Starting the agent                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Starts `opencode acp`, resolving a bare command name first if the host's
   * `PATH` cannot see it.
   *
   * Under Remote-SSH this is the difference between working and a dead chat.
   * The VS Code server is launched by a non-interactive SSH command, so the
   * extension host's `PATH` has never seen the user's profile: `~/.opencode/bin`,
   * `~/.local/bin` and nvm's shims are all missing from it, and `opencode` looks
   * uninstalled on a box where it is installed. So a name that fails to spawn is
   * asked about in a login shell, and the agent is then started with both the
   * binary that shell reported and the `PATH` it would have given a terminal —
   * so the commands the agent runs afterwards can find `git`, `node` and the
   * rest.
   *
   * A configured *path* is never second-guessed. The user pointed at a file;
   * running some other `opencode` instead would be worse than an error.
   */
  private async launch(settings: OpenCodeSettings, args: string[]): Promise<Launched> {
    const remembered = this.resolved;
    if (remembered?.requested === settings.binaryPath) {
      try {
        const child = await this.spawnChild(remembered.binary, args, this.childEnv(settings, remembered.envPath));
        return { child, binary: remembered.binary };
      } catch (error) {
        // Whatever it found last time is gone or no longer runnable; fall
        // through and look again rather than repeating a failure.
        log.warn("remembered binary %s no longer starts: %s", remembered.binary, describeError(error));
        this.resolved = undefined;
      }
    }

    const binary = expandHome(settings.binaryPath, homedir());
    try {
      const child = await this.spawnChild(binary, args, this.childEnv(settings));
      this.resolved = undefined;
      return { child, binary };
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }

    const found = await this.discover(settings.binaryPath);
    if (!found) {
      throw this.missingBinary(settings.binaryPath);
    }

    log.info("resolved `%s` to %s on %s", settings.binaryPath, found.binary, hostLabel());
    const child = await this.spawnChild(found.binary, args, this.childEnv(settings, found.envPath));
    this.resolved = { requested: settings.binaryPath, binary: found.binary, envPath: found.envPath };
    return { child, binary: found.binary };
  }

  /**
   * The environment the agent is started with.
   *
   * A discovered login-shell `PATH` sits underneath `opencode.env` rather than
   * over it: a `PATH` the user set by hand is a decision, not a default.
   */
  private childEnv(settings: OpenCodeSettings, envPath?: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...(envPath ? { PATH: envPath } : {}),
      ...settings.env,
    };
  }

  private spawnChild(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<ChildProcessWithoutNullStreams> {
    return new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(binary, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env,
          windowsHide: true,
        });
      } catch (error) {
        reject(error);
        return;
      }
      // `spawn` reports a binary it cannot execute asynchronously, on `error`.
      // `spawn` itself is the only signal that it worked, and waiting for it is
      // what turns "the executable is missing" into a catchable failure here
      // instead of an unanswered handshake thirty seconds later.
      child.once("spawn", () => resolve(child));
      child.once("error", reject);
    });
  }

  /**
   * Asks the host's login shells where a bare command name lives.
   *
   * Each shell is tried in turn and the first answer wins. If none of them
   * reports the binary, the directories they would have had it in are checked
   * directly — a shell that fails to start still leaves a usable `PATH` behind
   * in the common case where the extension host itself carries one.
   */
  private async discover(name: string): Promise<{ binary: string; envPath?: string } | undefined> {
    // Windows resolves names through `PATHEXT`, and there is no login shell to
    // ask; a name that did not spawn there is simply not installed.
    if (process.platform === "win32" || isPathLike(name)) {
      return undefined;
    }

    let envPath: string | undefined;
    for (const probe of shellProbes(name)) {
      const result = await this.probeShell(probe);
      envPath = envPath ?? result.envPath;
      log.debug("login shell %s answered: %s", probe.shell, result.binary ?? "no binary");
      if (result.binary) {
        return { binary: result.binary, envPath: result.envPath ?? envPath };
      }
    }

    const home = homedir();
    for (const candidate of candidatePaths(name, home, envPath)) {
      if (isExecutable(candidate)) {
        log.info("found `%s` at %s on %s", name, candidate, hostLabel());
        return { binary: candidate, envPath };
      }
    }
    return undefined;
  }

  /** Runs one login-shell probe, giving up rather than hanging on a bad rc file. */
  private probeShell(probe: ShellProbe): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve) => {
      let settled = false;
      const finish = (result: ProbeResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      let child: ChildProcess;
      try {
        child = spawn(probe.shell, probe.args, {
          // stdin is closed so an rc file that prompts cannot sit here waiting
          // for an answer that will never come.
          stdio: ["ignore", "pipe", "ignore"],
          env: process.env,
          windowsHide: true,
        });
      } catch (error) {
        log.debug("login shell %s could not start: %s", probe.shell, describeError(error));
        resolve({});
        return;
      }

      let stdout = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.once("error", (error) => {
        log.debug("login shell %s failed: %s", probe.shell, describeError(error));
        finish({});
      });
      child.once("close", () => finish(parseProbe(stdout)));

      const timer = setTimeout(() => {
        log.warn("login shell %s did not answer in %ss; giving up on it", probe.shell, LOGIN_SHELL_TIMEOUT_MS / 1000);
        child.kill("SIGKILL");
        finish({});
      }, LOGIN_SHELL_TIMEOUT_MS);
      timer.unref?.();
    });
  }

  private lastStderrLine(): string | undefined {
    return this.stderrTail[this.stderrTail.length - 1];
  }

  /**
   * The message for a binary that could not be run.
   *
   * It has to name the host, because the `which opencode` that would fix this
   * is the one run *on that host* — a local shell finds a different answer, or
   * none at all.
   *
   * The two cases get different advice on purpose. A bare name that nothing
   * found is an installation question; a path that will not run is a typo or a
   * permission bit, and telling someone to make their absolute path absolute
   * again is noise.
   */
  private missingBinary(configured: string): AgentError {
    const where = hostLabel();
    if (isPathLike(configured)) {
      return new AgentError(
        `\`${configured}\` cannot be run on ${where}. Check that the file exists and is executable ` +
          `there — the extension host may not see what your login shell does — or point ` +
          `\`opencode.binaryPath\` at where OpenCode is installed on ${where}.`,
      );
    }
    return new AgentError(
      `Could not run \`${configured}\` on ${where}, and no login shell there has it either. ` +
        `Install OpenCode on ${where}, or set \`opencode.binaryPath\` to its absolute path in the ` +
        `Remote scope for this host — run \`which ${configured}\` in a VS Code terminal on ${where} ` +
        `to find it.`,
    );
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
    const detail = code === 0 ? undefined : exitDetail("opencode", code, signal, this.lastStderrLine());
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
      const where = hostLabel();
      return new AgentError(
        `Could not run \`${settings.binaryPath}\` on ${where}. Install OpenCode there, or set ` +
          `\`opencode.binaryPath\` to its absolute path — run \`which opencode\` in a VS Code ` +
          `terminal on ${where} to find it. The extension host may not inherit your login shell's PATH.`,
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
      // A child that died during the handshake has already emitted `exit`, so
      // waiting for another one would wait forever — which is how a failed start
      // could leave the panel stuck on *starting* with no error. An exit code or
      // signal on the handle is how Node says it is over.
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const done = () => resolve();
      child.once("exit", done);
      child.stdin.end();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        // Nothing more can be done about a process that will not die, and the
        // caller is waiting on this to report the failure to the user.
        resolve();
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
 * How a child process says "there is nothing there to run".
 *
 * `ENOENT` is the one that matters on a remote host — that is a binary missing
 * from a `PATH` that never saw the user's profile. `EACCES` counts too: a
 * `~/.opencode/bin/opencode` that lost its executable bit is the same problem
 * wearing a different mask, and the login shell finds it either way.
 */
function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ENOENT" || code === "EACCES";
}

/** Whether a path is a file this process is allowed to execute. */
function isExecutable(path: string): boolean {
  try {
    const { mode } = statSync(path);
    // The executable bit matters: a candidate that cannot be run would just
    // fail again with `EACCES`, only now after the login-shell detour.
    return process.platform === "win32" || (mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * What a dead agent said on its way out.
 *
 * The last line of stderr is kept for exactly this: a binary that starts and
 * then dies usually says why (a wrong version, a broken install, a missing
 * shared library) and that is the whole difference between a usable error and
 * a shrug.
 */
function exitDetail(
  binary: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  lastStderr?: string,
): string {
  const how = signal ? `signal ${signal}` : `code ${code}`;
  return `\`${binary}\` exited with ${how}${lastStderr ? `: ${lastStderr}` : ""}.`;
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