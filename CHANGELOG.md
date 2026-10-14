# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-10-14

### Fixed

- A session that reports a *non-empty* `model` list no longer hides the models
  its machine can reach but the session did not mention. The host's catalog was
  only consulted when the session offered nothing, so any provider the agent
  chose not to enumerate simply vanished from the picker — most visibly over
  Remote-SSH, where a custom provider such as OmniRouter is configured in
  `opencode.json` but is missing from what the agent reports, leaving the
  provider section absent on a machine that is configured for it. The two lists
  are now joined instead of swapped: the session's models lead, in its order and
  under its labels, the machine's are appended without repeats, and the model
  the session says it is on keeps the tick. The picker says when the host
  contributed to what is on screen.
- An agent that dies while introducing itself now reports why, instead of
  `write EPIPE`. Writing to a child that has already exited raises `EPIPE` rather
  than a close, and on some Node versions that beat the exit event — so the exit
  code and the agent's last line of stderr, which were already in hand, were
  thrown away in favour of the transport's word for it.

## [0.2.1] - 2026-10-14

### Added

- The model picker is now searchable and grouped by provider, so every model a
  machine offers is reachable instead of one flat wall of rows. Type to filter —
  the label, the model id and the provider are all searched, and the count
  reads `3 of 148 models`. `↑`/`↓` walk the results, `Enter` picks the
  highlighted one, `Escape` closes, and the filter and the counts stay put while
  the list scrolls. Sections are headed by the name the provider's own config
  gives it, so a custom provider reads as **OmniRouter** rather than `corphub`.
- The models the OpenCode TUI has recently used, and the ones starred in it,
  now lead the picker. They are read from that TUI's own `model.json`, so the
  extension starts from the models you actually work with and agrees with the
  TUI about which those are. Anything the TUI remembers that this session cannot
  offer is left out rather than shown as a choice that would be refused.

### Fixed

- A session that reports a `model` option with no choices in it no longer
  suppresses the host's own model list. An empty select says the agent offered
  no list at all, so the machine's `opencode models` is used instead — which
  matters for providers that only that command reports, such as a custom
  provider like OmniRouter. Previously the picker read *Agent did not offer any
  models* on a host that could in fact list every model it can reach. The host's
  list also replaces the empty option rather than sitting beside it, which had
  left the empty one shadowing it.

## [0.2.0] - 2026-10-14

### Added

- The chat now says which machine its settings come from. Under Remote-SSH,
  WSL or a container that is the box on the other end, and it is not guessable:
  the model list, the agents and the config directory all belong to the remote
  host, not to the machine the window is on. The **more** menu reports the host,
  the `opencode` version, the binary that answered, where that install keeps
  its config, how many models it offers and how many config sources it loaded.
- The machine the agent runs on is asked for its own OpenCode settings, with
  the same binary and environment the agent was started with: `opencode debug
  paths`, `opencode debug config` (including a project `opencode.json`),
  `opencode models` and `opencode debug agents`. Over SSH this is what the
  remote server has configured. It is read in the background, so it never
  delays the first prompt, and a machine that answers nothing reports less.
- A session that offers no model list of its own now falls back to the models
  that machine reports, instead of leaving the picker reading *Agent did not
  offer any models*. The list says which host it came from, and a pick the
  session refuses is reported rather than silently ignored.
- The last model you picked is remembered and restored on every new chat, the way
  the TUI does. `opencode acp` starts each session on its own default
  (`opencode/cat-jam-free` unless `opencode.json` pins one) and never reads the
  TUI's `model.json`, so the extension has to keep that memory itself. A model
  the session no longer offers is skipped rather than forced.
- Permission and question prompts take focus when they arrive and answer the
  keyboard: `Enter` approves once (or submits), `Escape` declines, `←`/`→` walk
  the options. Focus is skipped only while you are mid-sentence.
- A message sent while the agent is still working waits in a queue above the
  composer instead of sitting in the transcript badged `Queued`, the way an
  editor parks what it will send next. Rows are numbered in run order and
  disappear as they start, at which point the message joins the chat — so a
  transcript bubble always means the agent actually has it. If the queue is
  discarded — you stopped the turn, started a new chat, or the agent died —
  those messages come back into the transcript marked `Not sent` rather than
  being lost.
- Type `@` in the composer to attach a file. A picker opens above the input and
  narrows as you type; `↑`/`↓` choose, `Enter` or `Tab` attaches, `Escape`
  dismisses. The workspace is walked once and cached, skipping `node_modules`
  and friends, and picks the most likely file first — an exact name beats a
  longer one starting the same, and a shallower path wins a tie.
- The context meter survives a reload. Neither `session/new` nor `session/load`
  reports usage, so a reopened conversation sat with an empty status bar until
  a turn streamed an update. Each session's last reading is remembered — keyed by
  session id, in a store that keeps the ten most recent — and seeded back when
  that same conversation is reopened.

### Changed

- The context meter now measures the context window, the way the TUI does. It
  was dividing ACP's `Usage.totalTokens` — every token billed across the whole
  session — by the model's context window, so it filled up within a few turns
  and then sat pinned at 100%. The status bar now reads `12k / 200k  6.0%  $0.412`,
  escalates through amber to red as compaction approaches, and falls back to a
  plain token count when the window size is unknown.
- The status bar shows a spinner while a turn is running and while OpenCode is
  starting. `Working…` used to be static text, so a live turn was
  indistinguishable from a stalled one.
- The folder name no longer appears in the status bar above the composer.
- The confirmation dialog was rebuilt. Approvals and rejections are now split by
  a divider instead of sitting in one undifferentiated row, and each option is
  weighted by what it actually does: a one-off approval is the solid primary,
  while the `always` variants stay outlined so a stray click cannot quietly
  widen the agent's permissions for the rest of the session. Destructive prompts
  get an accent rail, commands scroll instead of being clipped, and the buttons
  meet the 24px minimum target size (they were 21px).
- A permission prompt now scrolls itself into view when it arrives. The
  transcript only auto-scrolled when you were already at the bottom, so a prompt
  could arrive off-screen while the agent silently waited.
- User message bubbles no longer carry a blank line at the bottom. `marked`
  ends every block with a newline and the bubble inherited `white-space:
  pre-wrap`, which turned that into a forced line break.
- The extension icon is a plain rectangle, matching the OpenCode logo, instead of
  the two-block mark.
- Tool calls no longer each get a card. A run of consecutive finished calls
  collapses into a single summary row — "Read 3 files · Edited 1 file · Ran 1
  command" — that opens into the full list, with diffs and output intact. Calls
  that are running or failed keep their own row, since that is when they are
  worth watching. A lone call still shows its own title.
- The composer is three lines tall instead of one and grows with what you type
  (up to 240px, then scrolls). `Enter` sends, `Shift+Enter` adds a line.

### Removed

- The empty-state suggestion prompts. They were three canned questions parked
  in the middle of the panel, and they lingered under the conversation instead
  of getting out of the way.

### Fixed

- The chat never started over Remote-SSH, WSL or in a container, and said
  nothing about why. `spawn` reports a missing executable asynchronously, and
  the only handler for it wrote a line to the output channel — so the agent's
  handshake was left waiting on a process that would never answer, and the
  teardown that followed waited for an `exit` event a child that never spawned
  cannot emit. The panel sat on *starting* indefinitely. The spawn is now
  awaited, the handshake is raced against the agent's death, and a binary that
  cannot be run fails in milliseconds with a message naming the host it was
  looked for on.
- `opencode` could not be found on a remote host even though it was installed
  there. The VS Code server is started by a non-interactive SSH command, so the
  extension host's `PATH` never went through the user's profile — which is where
  the installer puts `~/.opencode/bin`, and where nvm keeps its shims. A bare
  `opencode` that will not spawn is now resolved by asking the host's login
  shell, and the agent is started with the `PATH` that shell would have given a
  terminal, so the commands it runs afterwards can find `git` and `node` too. A
  configured *path* is still used exactly as written rather than silently
  replaced by a different `opencode`.
- The context meter showed the previous chat's tokens. A single reading was
  stored for the whole window and handed to whichever session opened next, so
  restarting VS Code opened a new conversation already reading `75k / 1.0M` it
  had never incurred, and reopening a chat from the history list showed
  whichever conversation streamed last. Readings are stored per session now and
  only that session's own reading is seeded back; a new chat starts empty until
  its first turn streams a `usage_update`.
- The typing indicator stayed on screen after the turn ended. The transcript
  cache keyed an agent message on its text alone, so a message whose only
  change was "no longer streaming" was never redrawn — the dots kept bouncing
  forever. The dots now also require a turn to actually be running.
- "What should we build?" survived the first message. The greeting was written
  into the transcript outside the cache that reconciles it, so nothing ever
  removed it; it sat at the bottom of the conversation and the view scrolled
  straight to it.
- Switching connection states stranded the old greeting on screen. A rebuilt
  element was added to the transcript without removing the one it replaced, so
  "Starting OpenCode…" stayed put after the agent connected.

## [0.1.0] - 2026-10-13

Initial release.

### Added

- Chat panel in the activity bar, plus a command to open the same chat in an
  editor tab.
- ACP transport: spawns `opencode acp` and speaks newline-delimited JSON-RPC
  using `@agentclientprotocol/sdk`.
- Full transcript rendering: markdown with syntax-highlighted code blocks, images,
  and collapsible reasoning streams.
- Tool calls as collapsible cards with status icons, output previews, touched
  file links, and inline diffs of file changes.
- Permission prompts rendered inline with the command or diff under review, plus
  a warning for commands that look destructive.
- Agent questions (ACP elicitation) rendered as single- and multi-select forms.
- Model, mode and reasoning-effort pickers driven by the agent's session config
  options, with live updates when the agent changes them.
- Plan checklist, retry banner, context-compaction markers, and a token/cost
  readout.
- Session history: list, resume and delete past conversations per workspace.
- Editor commands: `Ask About Selection`, `Explain Selection`, `Ask About File`.
- Sign-in flow that drives `opencode acp --login` in a VS Code terminal.
- Permission policy setting (`ask`, `autoRead`, `all`) and inline vs. native
  diff preview setting.

### Fixed

- The model, mode and toolbar menus now stay open when clicked. An outside-click
  listener on `document` was closing them with the very same click that opened
  them, so every dropdown flashed and vanished.
- The "more" menu opens below the toolbar button instead of above the panel,
  where it was positioned off-screen.
- The attach button no longer does nothing when no editor has the focus: it
  offers the open tabs, or the workspace files when nothing is open.
- Models are shown by a readable name (`Cat Jam Free`) rather than by their
  provider-prefixed id (`opencode/cat-jam-free`), on the composer chip and in
  the picker.