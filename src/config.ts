import * as vscode from "vscode";

import { expandHome } from "./shared/binary.js";

export const CONFIG_SECTION = "opencode";

export interface OpenCodeSettings {
  binaryPath: string;
  extraArgs: string[];
  env: Record<string, string>;
  configFile?: string;
  configDir?: string;
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
    configFile: config.get<string>("configFile") || undefined,
    configDir: config.get<string>("configDir") || undefined,
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

/**
 * The extra OpenCode config this workspace asks for, as the environment the
 * agent has to be started with for it to be loaded.
 *
 * OpenCode reads `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` itself and merges
 * what they point at into the config it would otherwise load, so handing the
 * agent this environment is what makes a provider configured in one of those
 * files a provider the session can actually use — and therefore a section in
 * the model picker, rather than a file nothing ever opened.
 *
 * This is the way to point at a config file without editing a shell profile,
 * which over Remote-SSH is a file the extension host never reads anyway. A
 * value set here outranks one a login shell exports; `opencode.env` outranks
 * both.
 */
export function configEnvironment(settings: OpenCodeSettings, home: string | undefined): Record<string, string> {
  const environment: Record<string, string> = {};
  if (settings.configFile) {
    environment.OPENCODE_CONFIG = expandHome(settings.configFile, home);
  }
  if (settings.configDir) {
    environment.OPENCODE_CONFIG_DIR = expandHome(settings.configDir, home);
  }
  return environment;
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