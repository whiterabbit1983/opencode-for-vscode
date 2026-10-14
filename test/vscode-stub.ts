/**
 * A minimal stand-in for the `vscode` module, aliased in when bundling the
 * smoke test so it can drive the real agent outside an extension host.
 *
 * Only the surface `config.ts` and `logger.ts` actually touch is provided.
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
};

export const window = {
  createOutputChannel() {
    return {
      appendLine: (line: string) => process.stderr.write(`[opencode] ${line}\n`),
      show() {},
      dispose() {},
    };
  },
};

/**
 * `config.ts` reads `remoteName` to decide whether the agent runs locally or on
 * a remote host. Off by default, which is what a plain terminal looks like.
 * Override with `OPENCODE_FAKE_REMOTE_NAME` to exercise the remote wording.
 */
export const env = {
  remoteName: process.env.OPENCODE_FAKE_REMOTE_NAME,
};

export class Disposable {
  constructor(private readonly fn: () => void = () => undefined) {}
  dispose(): void {
    this.fn();
  }
}

export default { workspace, window, env, Disposable };