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
 *
 * The same gap decides *which OpenCode config is loaded*, not just where the
 * binary is. `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` are exported from a
 * profile far more often than not, so a profile the extension host has not seen
 * is also a profile whose custom config file — and the provider definitions in
 * it — the agent never loads.
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

/** Markers identifying the answers in a probe's output. */
export const PATH_MARKER = "OC_PATH=";
export const BINARY_MARKER = "OC_BIN=";
export const CONFIG_MARKER = "OC_CONFIG=";

/**
 * The variables that decide *which* OpenCode config files exist.
 *
 * OpenCode loads a custom config file (`OPENCODE_CONFIG`) and a custom config
 * directory (`OPENCODE_CONFIG_DIR`) on top of the ones it discovers by itself,
 * and a provider that only exists in one of those is invisible to every
 * command run without them. They are nearly always `export`ed from a shell
 * profile, which is precisely what the extension host has not seen: over
 * Remote-SSH it is started by a non-interactive SSH command, so an agent
 * launched from it comes up without those config files and every model behind
 * them — a custom provider such as OmniRouter — is missing from the picker.
 *
 * Only the two path-shaped variables are asked for. `OPENCODE_CONFIG_CONTENT`
 * carries a config document inline, which may span lines and may hold a key;
 * there is no line-based way to carry it out of a shell safely, and an
 * extension host that has it in its own environment passes it through anyway.
 */
export const CONFIG_ENV_VARS = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"] as const;

/**
 * The script a login shell is asked to run.
 *
 * The values come back in one shot because they are wanted together: where the
 * binary is, the `PATH` the user's login shell would hand to a terminal, and
 * the OpenCode config environment that shell exports. Handing that `PATH` to
 * the agent is not a nicety — every command the agent runs afterwards (its
 * shell tool, `git`, `node`) inherits it, so a remote box with a bare
 * extension-host `PATH` otherwise runs an agent that cannot find its own tools.
 * The config environment is asked for on the same terms: a provider that only
 * a custom config file defines cannot be reached without it.
 *
 * The answers are marked rather than printed bare because an interactive shell
 * is allowed to say anything on the way — job-control warnings, MOTD lines from
 * an rc file — and the answer has to be told apart from that noise.
 *
 * `shell` is what makes the rc files reachable. A *login* shell reads
 * `/etc/profile` and then one of `~/.bash_profile`, `~/.bash_login` or
 * `~/.profile`, stopping at the first that exists — and does not read
 * `~/.bashrc` at all unless one of those sources it. Ubuntu and Debian ship a
 * `~/.profile` that does exactly that, so `-i` is enough there; a home holding
 * only a `~/.bashrc`, which is common on a box set up by hand, is never read by
 * a login shell however interactive it is, and a profile that exports
 * `OPENCODE_CONFIG` or appends to `PATH` goes unheard. So bash is handed that
 * file explicitly, which costs one extra read of something idempotent for the
 * two things this script asks about.
 */
export function probeScript(binary: string, shell?: string): string {
  return [
    ...(shell && isBash(shell) ? [`[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"`] : []),
    `printf '${PATH_MARKER}%s\\n' "$PATH"`,
    `printf '${BINARY_MARKER}%s\\n' "$(command -v ${shellQuote(binary)} 2>/dev/null)"`,
    ...CONFIG_ENV_VARS.map((name) => `printf '${CONFIG_MARKER}%s=%s\\n' "${name}" "$${name}"`),
  ].join("\n");
}

/** Whether a shell reads its rc files the way bash does. */
function isBash(shell: string): boolean {
  return /(^|\/)bash$/.test(shell);
}

/** The environment a login shell reported, as far as this extension cares. */
export interface ShellEnv {
  /** The `PATH` a login shell would give a terminal, if it printed one. */
  envPath?: string;
  /**
   * The OpenCode config variables the login shell exports.
   *
   * Absent when the shell exports none, or could not be asked at all — which
   * is not an error, only an environment nobody has described.
   */
  configEnv?: Record<string, string>;
}

export interface ProbeResult extends ShellEnv {
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
  let configEnv: Record<string, string> | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith(PATH_MARKER)) {
      envPath = line.slice(PATH_MARKER.length).trim() || undefined;
    } else if (line.startsWith(BINARY_MARKER)) {
      const value = line.slice(BINARY_MARKER.length).trim();
      if (value && isPathLike(value)) {
        binary = value;
      }
    } else if (line.startsWith(CONFIG_MARKER)) {
      // `NAME=value`, and a variable the shell left unset is not an answer.
      const entry = line.slice(CONFIG_MARKER.length);
      const at = entry.indexOf("=");
      const name = at < 0 ? "" : entry.slice(0, at);
      const value = at < 0 ? "" : entry.slice(at + 1).trim();
      if (value && CONFIG_ENV_VARS.includes(name as (typeof CONFIG_ENV_VARS)[number])) {
        configEnv = { ...configEnv, [name]: value };
      }
    }
  }
  // Left off entirely when there is nothing to say, so a probe that only had
  // the old two answers to give still compares equal to what it always did.
  return configEnv ? { envPath, binary, configEnv } : { envPath, binary };
}

/**
 * The environment a child process is started with.
 *
 * Lowest precedence first: the extension host's own environment, then what a
 * login shell reported, then what this workspace configured. A value a person
 * set by hand outranks one that was merely inherited — the whole reason the
 * shell's answers are read is that the environment underneath them is missing
 * what a terminal would have had, not that it is wrong.
 */
export function composeEnv(
  base: NodeJS.ProcessEnv,
  shell: ShellEnv | undefined,
  configured: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...base,
    ...(shell?.envPath ? { PATH: shell.envPath } : {}),
    ...shell?.configEnv,
    ...configured,
  };
}

export interface ShellProbe {
  shell: string;
  args: string[];
}

/**
 * The shells worth asking, most faithful first.
 *
 * `$SHELL` is what a terminal on this box would be, so it goes first; `-i` is
 * then what reaches an rc file that returns early for a non-interactive shell,
 * and `~/.opencode/bin` is appended in exactly such a file. Which file that is
 * varies by shell, so each is asked with a script written for it — see
 * `probeScript`. `/bin/sh` is asked without `-i` because no `sh` has interactive
 * rc files worth the risk of one of them hanging on a prompt.
 *
 * Empty when there is no shell to ask — Windows has `ComSpec`, but a `PATH`
 * that a login shell would have printed is not a thing that exists there.
 */
export function shellProbes(binary: string, env: { SHELL?: string } = {}): ShellProbe[] {
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
    args:
      shell.endsWith("/sh") || shell === "sh"
        ? ["-l", "-c", probeScript(binary, shell)]
        : ["-l", "-i", "-c", probeScript(binary, shell)],
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