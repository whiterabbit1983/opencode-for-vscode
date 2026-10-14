import * as vscode from "vscode";

export const CONFIG_SECTION = "opencode";

export interface OpenCodeSettings {
  binaryPath: string;
  extraArgs: string[];
  env: Record<string, string>;
  permissions: "ask" | "autoRead" | "all";
  diffView: "inline" | "editor" | "off";
  showThoughts: boolean;
  showPlan: boolean;
  fontSize: number;
  maxToolOutputLines: number;
  confirmDestructiveCommands: boolean;
  reuseLastSession: boolean;
}

export function readSettings(): OpenCodeSettings {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    binaryPath: config.get<string>("binaryPath") || "opencode",
    extraArgs: config.get<string[]>("extraArgs") ?? [],
    env: (config.get<Record<string, string>>("env") ?? {}) as Record<string, string>,
    permissions: config.get<OpenCodeSettings["permissions"]>("permissions") ?? "ask",
    diffView: config.get<OpenCodeSettings["diffView"]>("diffView") ?? "inline",
    showThoughts: config.get<boolean>("showThoughts") ?? false,
    showPlan: config.get<boolean>("showPlan") ?? true,
    fontSize: config.get<number>("fontSize") ?? 0,
    maxToolOutputLines: config.get<number>("maxToolOutputLines") ?? 40,
    confirmDestructiveCommands: config.get<boolean>("confirmDestructiveCommands") ?? true,
    reuseLastSession: config.get<boolean>("reuseLastSession") ?? false,
  };
}

/** Fires whenever any `opencode.*` setting changes. */
export function onSettingsChanged(handler: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(CONFIG_SECTION)) {
      handler();
    }
  });
}

/**
 * Names the machine the agent actually runs on. `extensionKind` pins this
 * extension to the workspace host, so under Remote-SSH that is the remote box.
 * Anything that has to tell the user which binary is missing — or where to look
 * for it — must name that machine, because a `which opencode` run in their
 * local terminal finds a different one.
 */
export function hostLabel(): string {
  const remote = vscode.env.remoteName;
  return remote ? `the remote host (${remote})` : "this machine";
}