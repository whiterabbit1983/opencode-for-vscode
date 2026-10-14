# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
  a turn streamed an update. The last reading is remembered — global, like the
  model — and seeded back on every new or resumed chat.

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