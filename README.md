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
come from a different install than the one answering your prompts. If the
session offers a model list of its own, that list wins; if it does not, the
machine's models fill the picker instead and the menu says where they were read
from.

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

Nothing is dropped to make room: a model missing from the picker means that
machine's OpenCode does not offer it, which is what the **more** menu's model
count reflects.

The list is the session's own models first — in the order the agent reports them
— with the machine's own `opencode models` added behind them. That matters for a
custom provider: an agent does not always enumerate a provider configured in
`opencode.json`, and the host catalog is what knows about it. When the host
contributed to the list, the picker says so.

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
`remote-host`, `remote-host-model-fallback`. Add `&expand=N` to open the first
`N` tool cards, or `&menu=model|mode|more` to leave a menu open.

## License

MIT — see [LICENSE](LICENSE).