/**
 * Finding the `opencode` executable on the machine the agent actually runs on.
 *
 * `extensionKind` pins this extension to the workspace extension host, so
 * under Remote-SSH (and WSL, containers, Codespaces) everything here happens
 * on the remote box. That box has the environment a non-interactive SSH
 * command gives the VS Code server: a bare `PATH` that never went through the
 * user's profile. Installers append `~/.opencode/bin` to `~/.bashrc`, nvm keeps
 * its shims under `~/.nvm/versions/node`, and neither is visible to a child
 * process spawned from the extension host — which is precisely the case of
 * "opencode is not found" on a machine where it is plainly installed.
 *
 * The helpers here are the pure part of the answer: building a login-shell
 * probe, reading its answer back, and listing where else to look when even that
 * comes up empty. `src/agent/opencode-agent.ts` does the spawning.
 */

/**
 * Whether a configured value already says where the binary lives.
 *
 * A value with a separator in it is the user's decision, not a `PATH` lookup:
 * they pointed at a specific file, so it is used exactly as written and never
 * silently replaced by a different `opencode` found elsewhere. Only a bare
 * command name may be resolved for them.
 */
export function isPathLike(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

/**
 * Expands a leading `~`.
 *
 * `spawn` does not run a shell, so it does not expand `~` either — the path is
 * passed to `execve` literally and fails with `ENOENT`.
 */
export function expandHome(value: string, home: string | undefined): string {
  if (!home) {
    return value;
  }
  if (value === "~") {
    return home;
  }
  return value.startsWith("~/") ? `${home}/${value.slice(2)}` : value;
}

/**
 * Quotes one word for a script that is assembled here rather than typed by a
 * user.
 *
 * The sign-in terminal in `chat-session.ts` quotes differently on purpose: that
 * line is shown to a person, so it stays readable. This one only has to be
 * correct, whatever someone put in `opencode.binaryPath`.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Markers identifying the two answers in a probe's output. */
export const PATH_MARKER = "OC_PATH=";
export const BINARY_MARKER = "OC_BIN=";

/**
 * The script a login shell is asked to run.
 *
 * Two values come back in one shot because they are wanted together: where the
 * binary is, *and* the `PATH` the user's login shell would hand to a terminal.
 * Handing that `PATH` to the agent is not a nicety — every command the agent
 * runs afterwards (its shell tool, `git`, `node`) inherits it, so a remote box
 * with a bare extension-host `PATH` otherwise runs an agent that cannot find
 * its own tools.
 *
 * The answers are marked rather than printed bare because an interactive shell
 * is allowed to say anything on the way — job-control warnings, MOTD lines from
 * an rc file — and the answer has to be told apart from that noise.
 */
export function probeScript(binary: string): string {
  return [
    `printf '${PATH_MARKER}%s\\n' "$PATH"`,
    `printf '${BINARY_MARKER}%s\\n' "$(command -v ${shellQuote(binary)} 2>/dev/null)"`,
  ].join("\n");
}

export interface ProbeResult {
  /** The `PATH` a login shell would give a terminal, if it printed one. */
  envPath?: string;
  /** Where the login shell says the binary lives. */
  binary?: string;
}

/**
 * Reads a probe's answer out of whatever else the shell printed.
 *
 * A `command -v` hit that is not a path is discarded: it can be a shell
 * function or an alias, and neither is something a child process can be
 * started with.
 */
export function parseProbe(stdout: string): ProbeResult {
  let envPath: string | undefined;
  let binary: string | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith(PATH_MARKER)) {
      envPath = line.slice(PATH_MARKER.length).trim() || undefined;
    } else if (line.startsWith(BINARY_MARKER)) {
      const value = line.slice(BINARY_MARKER.length).trim();
      if (value && isPathLike(value)) {
        binary = value;
      }
    }
  }
  return { envPath, binary };
}

export interface ShellProbe {
  shell: string;
  args: string[];
}

/**
 * The shells worth asking, most faithful first.
 *
 * `-i` is the part that matters: a `~/.bashrc` returns early for
 * non-interactive shells, and `~/.opencode/bin` is appended there, so `-l`
 * alone would source `~/.bash_profile` and miss it. `/bin/sh` is asked without
 * `-i` because no `sh` has interactive rc files worth the risk of one of them
 * hanging on a prompt.
 *
 * Empty when there is no shell to ask — Windows has `ComSpec`, but a `PATH`
 * that a login shell would have printed is not a thing that exists there.
 */
export function shellProbes(binary: string, env: { SHELL?: string } = {}): ShellProbe[] {
  const script = probeScript(binary);
  const asked: string[] = [];
  for (const shell of [env.SHELL, "/bin/bash", "/bin/zsh", "/bin/sh"]) {
    if (shell && !asked.includes(shell)) {
      asked.push(shell);
    }
  }
  return asked.map((shell) => ({
    shell,
    // `sh` is last and deliberately non-interactive; the rest want their rc
    // files however they are configured.
    args: shell.endsWith("/sh") || shell === "sh" ? ["-l", "-c", script] : ["-l", "-i", "-c", script],
  }));
}

/**
 * Where to look when a bare name could not be spawned and the login shells did
 * not produce a path either.
 *
 * Only reached for a bare command name: a configured path that does not exist
 * is the user's path, and quietly running some other `opencode` instead would be
 * worse than the error.
 */
export function candidatePaths(binary: string, home: string | undefined, envPath?: string): string[] {
  const candidates: string[] = [];
  for (const dir of envPath?.split(":") ?? []) {
    if (dir) {
      candidates.push(`${dir}/${binary}`);
    }
  }
  for (const dir of [home && `${home}/.opencode/bin`, home && `${home}/.local/bin`, home && `${home}/.bun/bin`, "/usr/local/bin"]) {
    if (dir) {
      candidates.push(`${dir}/${binary}`);
    }
  }
  return candidates;
}