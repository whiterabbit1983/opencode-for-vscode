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

export class Disposable {
  constructor(private readonly fn: () => void = () => undefined) {}
  dispose(): void {
    this.fn();
  }
}

export default { workspace, window, Disposable };