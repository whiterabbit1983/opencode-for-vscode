/**
 * A minimal stand-in for the `vscode` module, aliased in when bundling the
 * smoke test so it can drive the real agent outside an extension host.
 *
 * Only the surface `config.ts` and `logger.ts` actually touch is provided.
 */

const SETTINGS: Record<string, unknown> = {
  binaryPath: process.env.OPENCODE_BIN ?? "opencode",
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
      get: (key: string) => SETTINGS[key],
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