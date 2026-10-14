/**
 * Asking the machine the agent runs on for its OpenCode settings.
 *
 * Under Remote-SSH this module runs on the remote box, and every command it
 * spawns therefore reports the remote machine's configuration — which is the
 * whole point. The binary and environment are the ones the agent itself was
 * started with, so the settings cannot come from a different install than the
 * one answering prompts.
 *
 * Nothing in here is allowed to fail the chat. Every command is optional, gets
 * its own timeout, and a machine whose OpenCode predates one of them simply
 * reports less.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { describeError, log } from "../logger.js";
import {
  NO_TUI_MODELS,
  parseAgents,
  parseConfigSources,
  parseModels,
  parsePaths,
  parseProviders,
  parseTuiModels,
  parseVersion,
  type AgentView,
  type ConfigSourceView,
  type PathsView,
  type ProviderView,
  type TuiModelMemory,
} from "../shared/opencode-cli.js";

/** How long a settings command may take before it is given up on. */
const COMMAND_TIMEOUT_MS = 15_000;

/** `--version` and `debug paths` are local lookups and answer at once. */
const FAST_COMMAND_TIMEOUT_MS = 5_000;

/**
 * Everything the extension learned about the OpenCode install it is talking to.
 *
 * Every field is optional: a field is present only when the command that fills
 * it answered, so an older install is described by what it did report.
 */
export interface HostInfo {
  /** The executable that was actually run. */
  binary: string;
  /** Version of the install, when it reported one. */
  version?: string;
  /** Where its settings live on this machine. */
  paths?: PathsView;
  /** Config sources in load order, including any project-level `opencode.json`. */
  sources?: ConfigSourceView[];
  /** Models the host can reach with its configured providers. */
  models?: string[];
  /** The providers behind them, under the names their config gives them. */
  providers?: ProviderView[];
  /** Which models the OpenCode TUI has recently used and starred. */
  tuiModels?: TuiModelMemory;
  /** Agents the host has configured. */
  agents?: AgentView[];
  /** Why the settings could not be read, when they could not. */
  error?: string;
}

export interface HostInfoOptions {
  /** The binary the agent was started from — never re-resolved. */
  binary: string;
  /** The environment that binary was started with. */
  env: NodeJS.ProcessEnv;
  /** The session's directory, so a project `opencode.json` is part of the answer. */
  cwd: string;
  timeoutMs?: number;
}

/**
 * Reads a machine's OpenCode settings.
 *
 * Never rejects: a host that cannot answer is reported as an `error` on the
 * result, because the chat has already started by the time this runs and a
 * missing settings summary is not a reason to take it down.
 */
export async function readHostInfo(options: HostInfoOptions): Promise<HostInfo> {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const run = (args: string[], ms = timeoutMs) => capture(options, args, ms);

  // The catalog and the agent list come from the host's running service, so they
  // are the slow ones; everything else is answered from the filesystem.
  const [version, paths, configJson, models, agents] = await Promise.all([
    run(["--version"], FAST_COMMAND_TIMEOUT_MS).then(parseVersion),
    run(["debug", "paths"], FAST_COMMAND_TIMEOUT_MS).then(parsePaths),
    run(["debug", "config"], FAST_COMMAND_TIMEOUT_MS),
    run(["models"]).then(parseModels),
    run(["debug", "agents"]).then(parseAgents),
  ]);
  const config = parseConfigSources(configJson);
  const providers = parseProviders(configJson);
  // Only readable once `debug paths` has said where the state directory is, so
  // this cannot join the batch above.
  const tuiModels = await readTuiModels(paths?.state);

  const info: HostInfo = { binary: options.binary, version, paths, sources: config, models, providers, tuiModels, agents };
  // A host that answered nothing at all is worth saying out loud: it usually
  // means the binary on this machine is not the one the user expects.
  if (!version && !paths?.config && !config.length && !models.length && !agents.length) {
    info.error = `\`${options.binary}\` did not report any OpenCode settings on ${machineName()}.`;
    log.warn("host settings: %s", info.error);
  } else {
    log.info(
      "host settings from %s: %s, %d model(s), %d agent(s), %d config source(s)",
      options.binary,
      version ? `v${version}` : "version unknown",
      models.length,
      agents.length,
      config.length,
    );
  }
  return info;
}

/**
 * Reads the TUI's own record of the models it has used.
 *
 * `model.json` sits in the state directory `debug paths` reports, so this runs
 * after it rather than beside it. It is the TUI's private file and it is
 * rewritten in place while the TUI runs, so a read that fails or comes back as
 * nothing usable is simply treated as *nothing remembered* — the picker loses a
 * shortcut, never the model list itself.
 */
async function readTuiModels(stateDir: string | undefined): Promise<TuiModelMemory> {
  if (!stateDir) {
    return NO_TUI_MODELS;
  }
  const path = join(stateDir, "model.json");
  try {
    const remembered = parseTuiModels(await readFile(path, "utf8"));
    log.info(
      "tui model memory from %s: %d recent, %d favourite",
      path,
      remembered.recent.length,
      remembered.favorite.length,
    );
    return remembered;
  } catch (error) {
    log.debug("`%s` could not be read: %s", path, describeError(error));
    return NO_TUI_MODELS;
  }
}

/**
 * Runs one settings command and returns its stdout.
 *
 * Resolves with an empty string on any failure — a missing subcommand, a
 * non-zero exit, a timeout — so one silent command cannot stop the others.
 */
function capture(options: HostInfoOptions, args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve) => {
    let settled = false;
    let stdout = "";
    // Declared before anything can finish: `spawn` throwing synchronously, or
    // the child reporting `error`, both settle the promise right here.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(value);
    };

    let child;
    try {
      child = spawn(options.binary, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      log.debug("`%s %s` could not start: %s", options.binary, args.join(" "), describeError(error));
      finish("");
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", (error) => {
      log.debug("`%s %s` failed: %s", options.binary, args.join(" "), describeError(error));
      finish("");
    });
    child.once("close", (code) => {
      if (code !== 0) {
        log.debug("`%s %s` exited with code %s", options.binary, args.join(" "), code);
      }
      finish(stdout);
    });

    timer = setTimeout(() => {
      log.debug("`%s %s` did not answer in %ss", options.binary, args.join(" "), timeoutMs / 1000);
      child.kill("SIGKILL");
      finish("");
    }, timeoutMs);
    timer.unref?.();
  });
}

/** The machine the extension is running on, for wording that names it. */
export function machineName(): string {
  return hostname() || process.env.HOSTNAME || "this machine";
}