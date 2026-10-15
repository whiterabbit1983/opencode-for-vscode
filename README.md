# OpenCode for VS Code

A native-feeling chat panel for [OpenCode](https://opencode.ai) inside VS Code.
It talks to the agent over the [Agent Client Protocol (ACP)](https://agentclientprotocol.com)
and renders everything — messages, tool calls, diffs, permission prompts and
questions — as a proper GUI. There is no embedded terminal and no console output
to sift through.

![OpenCode chat panel](resources/screenshot.png)

## What you get

- A **real chat surface**. Markdown, syntax-highlighted code blocks, copy buttons,
  and a composer with mode and model pickers that mirror what the agent offers.
- **Tool calls as cards.** Every read, edit, search and command collapses into a
  tidy row with a status icon. Expand it to see output, the files it touched, and
  an inline diff of what changed.
- **Diffs where you want them.** Render changes inline in the chat, or open them
  in VS Code's native diff editor. Click any file path to jump to it in the editor.
- **Permission prompts in context.** The agent asks inline, showing the exact
  command or diff, with a warning when a command looks destructive.
- **Agent questions.** When OpenCode needs input it raises a form, rendered as a
  small form card with single or multi-select choices.
- **Plans, retries, compaction and usage.** The checklist, the retry banner, the
  context-compaction marker, and a token/cost readout in the status strip.
- **Session history.** Browse previous chats for the workspace and resume any of
  them; the agent replays the transcript so nothing is lost.
- **Editor integration.** `Ask About Selection`, `Explain Selection` and
  `Ask About File` from the command palette or the editor context menu.

## Requirements

- VS Code 1.95 or newer
- [OpenCode](https://opencode.ai) v2 with ACP support (`opencode --version` should
  report 2.x). Sign in once with `opencode auth login`.

If `opencode` is not on your `PATH`, set `opencode.binaryPath` to the absolute
path printed by `which opencode`.

## Remote development (SSH, WSL, containers, Codespaces)

The extension declares `"extensionKind": ["workspace"]`, so it runs in the
**workspace** extension host, not the local one. Under Remote-SSH that means
`opencode` is started on the remote machine, and every file the agent reads or
writes, diff, and terminal is the remote one. Nothing needs to be configured
for this — it is the default.

Install the extension on the remote host: connect with Remote-SSH, then run
**Extensions: Install from VSIX…** and pick *Install in SSH: your-host* (not the
local one).

Two things are easy to get wrong:

- **`binaryPath` defaults to a bare `opencode`, and that is usually enough.**
  The VS Code server is started by a non-interactive SSH command, so the
  extension host's `PATH` has never seen your profile — `~/.opencode/bin`,
  `~/.local/bin` and nvm's shims are all missing from it. When the bare name
  will not start, the extension asks the remote login shell where `opencode` is
  and runs that, together with the `PATH` the shell would have given a terminal,
  so the agent's own commands find `git` and `node` as well. Set an absolute
  `opencode.binaryPath` in the *Remote [SSH: your-host]* scope if you want to
  skip the question — a configured path is used exactly as written and never
  resolved to some other `opencode`.
- **Install the extension on the remote host.** If the chat reports that it
  could not run `opencode` at all, check the extension is not only installed
  locally.

If the agent fails to start, the error names the host it tried to run on.

### Which machine's settings are these?

Everything the chat shows — the model list, the modes, the agents — comes from
the machine the **agent** runs on, which under Remote-SSH is the remote box and
never the local one. To see for yourself, open the **more** menu (`…` in the
header): it names the host, the `opencode` version, the binary that answered,
where that install keeps its config, how many models it offers and how many
config sources it loaded, global and project-level alike.

Those settings are read straight from that machine's own OpenCode, using the
same binary and environment the agent was started with, so what is shown cannot
come from a different install than the one answering your prompts. The **model
picker** is the exception, and deliberately so: it lists exactly the models the
agent offers, because a model the agent does not know about cannot be switched
to no matter what the machine has configured. The machine's own catalog still
appears in the **more** menu — its providers, their names, how many models there
are — as a description of the install rather than a list of choices.

If the list is empty, the header tooltip names the host and the binary: that is
the fastest way to tell a remote box that has not signed in to a provider from
one whose `opencode` is not the install you think it is.

### Finding a model

A machine with a few providers can offer hundreds of models, so the picker is
grouped and searchable rather than one flat list:

- **Recent** and **Favourites** come first, read from the OpenCode TUI's own
  `model.json` — the models you have actually used, and the ones you starred.
- Every other model sits under a heading naming the provider that serves it,
  taken from that provider's config, so a custom provider reads as *OmniRouter*
  rather than `corphub`. Each heading says how many models it holds.
- Type to filter. The label, the model id and the provider are all searched, so
  `opus`, `claude-opus` and `corphub` each find what you would expect, and the
  count reads `3 of 148 models`. `↑`/`↓` walk the results and `Enter` picks the
  highlighted one.

Nothing is dropped to make room: a model missing from the picker means the agent
did not offer it, which is also the only kind that could have been selected.

### If a provider is missing from the picker

A custom provider — OmniRouter, say, configured in `opencode.json` or named by
`OPENCODE_CONFIG` — is only in the picker once the agent itself enumerates it.
`session/set_config_option` resolves a model against the agent's own catalog and
answers `model not found` for anything absent from it, and there is no other
ACP route to select one. So the extension never adds rows of its own: a row it
cannot deliver is worse than a missing one, because a missing one sends you
looking at the real cause.

When `opencode models` and the agent's catalog disagree, the **more** menu says
so and names the file that declares the missing provider:

> **OmniRouter** is not offered by this session. 8 models are configured in
> `/srv/api/omnirouter.json`, which the agent has not loaded.

The same thing is written to the log (**Show log**), so it is on record even if
the menu is never opened. Two things produce that state:

- The agent started before the config was in its environment. See
  [below](#config-files-opencode-only-finds-through-the-environment), or point
  `opencode.configFile` / `opencode.configDir` at it and **Restart agent**.
- The provider is configured for a different directory than the session's. The
  **more** menu names every config source that install loaded.

A provider built into the install rather than configured — `opencode/*` — is
reported without a file, because no file is what is wrong.

### Config files OpenCode only finds through the environment

A provider does not have to live in `opencode.json`. OpenCode also loads a
config *file* named by `OPENCODE_CONFIG` and a config *directory* named by
`OPENCODE_CONFIG_DIR`, and those are usually exported from a shell profile — a
file the extension host has never read when VS Code got there over SSH, where it
is started by a non-interactive command. The agent then comes up without that
config, and every model behind the provider is missing from the picker while
the chat looks perfectly healthy.

So the extension asks your login shell for both variables, once per window, and
starts the agent with whatever it says — the same answer a terminal in that SSH
session would have given. If you would rather not go through a profile at all,
`opencode.configFile` and `opencode.configDir` set the same two variables
directly; on a remote host, set them in the **Remote [SSH: host]** scope. The
**more** menu then lists the config file among the sources OpenCode loaded,
which is how to confirm it arrived.

## Commands

| Command | What it does |
| --- | --- |
| `OpenCode: Open Chat` (`Ctrl+Alt+O`) | Focus the chat panel |
| `OpenCode: Open Chat in Editor Tab` | Open the same chat as a full editor tab |
| `OpenCode: New Chat` | Start a fresh conversation |
| `OpenCode: Resume Chat…` | Pick a previous chat from this workspace |
| `OpenCode: Stop Generating` | Cancel the current turn |
| `OpenCode: Ask About Selection` | Send the selection with a question |
| `OpenCode: Explain Selection` | Drop the selection into the composer |
| `OpenCode: Ask About File` | Reference the active file in the composer |
| `OpenCode: Sign In…` | Run `opencode auth login` in a VS Code terminal |
| `OpenCode: Restart Agent` | Restart the agent process |
| `OpenCode: Copy Last Response` | Copy the last assistant message |
| `OpenCode: Clear Local Chat History` | Start over |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `opencode.binaryPath` | `opencode` | Path to the `opencode` executable |
| `opencode.extraArgs` | `[]` | Extra arguments before `acp`, e.g. `["--print-logs"]` |
| `opencode.env` | `{}` | Extra environment variables for the agent |
| `opencode.configFile` | `""` | An extra OpenCode config file to load, as `OPENCODE_CONFIG` is |
| `opencode.configDir` | `""` | An OpenCode config directory to use instead of `~/.config/opencode` |
| `opencode.permissions` | `ask` | `ask`, `autoRead` (approve read-only tools) or `all` |
| `opencode.diffView` | `inline` | `inline`, `editor` (native diff) or `off` |
| `opencode.showThoughts` | `false` | Show the agent's reasoning stream |
| `opencode.showPlan` | `true` | Show the agent's execution plan |
| `opencode.fontSize` | `0` | Chat font size in pixels; `0` uses the default |
| `opencode.maxToolOutputLines` | `40` | Lines of tool output before collapsing |
| `opencode.confirmDestructiveCommands` | `true` | Warn before approving destructive commands |
| `opencode.reuseLastSession` | `true` | Reopen the previous chat on startup |

## How it works

The extension spawns `opencode acp` as a child process and speaks newline
delimited JSON-RPC (ACP v1) over its stdin/stdout using the official
`@agentclientprotocol/sdk`.

```
 webview (chat UI)  ⇄  WebviewHost  ⇄  ChatSession  ⇄  OpenCodeAgent  ⇄  opencode acp
```

- `OpenCodeAgent` owns the child process, negotiates capabilities during
  `initialize`, and exposes typed helpers for every ACP call the UI needs.
- `ChatSession` owns the conversation: it folds `session/update` notifications
  into an ordered transcript, and manages the request/response cycle for
  permission requests and elicitation questions.
- `ChatViewHost` keeps the webview in sync and routes user actions back to the
  session.
- The webview is plain TypeScript rendered into a sandboxed webview; every colour
  comes from VS Code theme variables, so the panel matches whatever theme you use.

A few deliberate choices:

- **No terminal capability is advertised.** OpenCode runs its own shell tool, so
  the chat never has to render a console.
- **File reads go through the editor**, so the agent sees unsaved buffer contents
  rather than what is on disk.
- **Diagnostics never touch the chat.** Agent logs go to the `OpenCode` output
  channel, which is only ever opened on request.

## Development

```sh
npm install
npm run build      # bundle the extension host and the webview
npm run watch      # rebuild on change
npm run compile    # type-check without emitting
npm test           # unit tests + extension bundle activation check
npm run smoke      # drive a real `opencode acp` and print the transcript
```

Press `F5` to launch an Extension Development Host with the extension loaded.

`npm test` covers the transcript reducer, the line diff, the markdown renderer
and the permission/form policies, then loads the built bundle against a stubbed
`vscode` API to confirm every command in `package.json` is actually registered.
It also starts the agent against stand-in binaries to prove the failures a
remote host causes — a `PATH` that never saw the user's profile, an executable
that dies instead of speaking ACP — fail with a usable message instead of
hanging, and that the settings shown in the chat are the ones the machine the
agent runs on actually has.

`npm run smoke` spawns the real agent, performs `initialize` and `session/new`,
sends a prompt, and folds the resulting `session/update` stream through the same
reducer the extension uses. It also prints what that machine's OpenCode reports
for its version, config sources, models and agents. On a machine with no
provider credentials it stops at `auth_required` — which is the sign-in path it
was designed to exercise.

### Previewing the UI

The webview can be rendered outside VS Code with sample data, which is the
fastest way to iterate on the interface:

```sh
npm run build
npm run preview            # writes screenshots of every scenario to dev/shots/
```

Scenarios: `transcript`, `permission`, `question`, `welcome`, `error`,
`remote-host`, `remote-host-no-models`, `omnirouter`, `omnirouter-missing`. Add
`&expand=N` to open the first `N` tool cards, or `&menu=model|mode|more` to leave
a menu open.

## License

MIT — see [LICENSE](LICENSE).