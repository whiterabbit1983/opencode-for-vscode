/**
 * A minimal stand-in for the `vscode` module, aliased in when bundling the
 * tests that drive the real agent outside an extension host.
 *
 * Only the surface `config.ts`, `logger.ts` and `chat-session.ts` actually
 * touch is provided.
 */

const SETTINGS: Record<string, unknown> = {
  extraArgs: process.env.OPENCODE_EXTRA_ARGS ? process.env.OPENCODE_EXTRA_ARGS.split(" ") : [],
  env: {},
  permissions: "ask",
  diffView: "inline",
  showThoughts: false,
  showPlan: true,
  fontSize: 0,
  maxToolOutputLines: 40,
  confirmDestructiveCommands: true,
  reuseLastSession: true,
};

export const workspace = {
  getConfiguration() {
    return {
      // `binaryPath` is read from the environment on every call rather than
      // captured above, so a test can point the agent at a different executable
      // partway through a run — which is how the startup failures are exercised.
      get: (key: string) => (key === "binaryPath" ? (process.env.OPENCODE_BIN ?? "opencode") : SETTINGS[key]),
      has: () => false,
      inspect: () => undefined,
    };
  },
  onDidChangeConfiguration() {
    return { dispose: () => undefined };
  },
  /** Only what an agent session touches when it asks for a file. */
  fs: {
    readFile: async () => new Uint8Array(),
    writeFile: async () => undefined,
  },
  textDocuments: [] as unknown[],
  workspaceFolders: undefined as unknown,
};

export const window = {
  createOutputChannel() {
    return {
      appendLine: (line: string) => process.stderr.write(`[opencode] ${line}\n`),
      show() {},
      dispose() {},
    };
  },
  createTerminal: () => ({ show() {}, sendText() {}, dispose() {} }),
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showWarningMessage: async () => undefined,
};

/**
 * `config.ts` reads `remoteName` to decide whether the agent runs locally or on
 * a remote host. Off by default, which is what a plain terminal looks like.
 * Override with `OPENCODE_FAKE_REMOTE_NAME` to exercise the remote wording.
 */
export const env = {
  // A getter, so a test can set the override after this module is loaded.
  get remoteName(): string | undefined {
    return process.env.OPENCODE_FAKE_REMOTE_NAME;
  },
  clipboard: { writeText: async () => undefined },
  openExternal: async () => true,
};

/** The minimum `ChatSession` needs to fire, subscribe to and dispose events. */
export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];

  readonly event = (listener: (value: T) => void): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((entry) => entry !== listener);
      },
    };
  };

  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

/** `vscode.Uri.file(path)` is all the session layer asks for. */
export const Uri = {
  file: (path: string) => ({ fsPath: path, scheme: "file", path, toString: () => `file://${path}` }),
  joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join("/") }),
  parse: (value: string) => ({ scheme: value.split(":")[0], path: value }),
};

export class Disposable {
  constructor(private readonly fn: () => void = () => undefined) {}
  dispose(): void {
    this.fn();
  }
}

export default { workspace, window, env, Disposable, EventEmitter, Uri };