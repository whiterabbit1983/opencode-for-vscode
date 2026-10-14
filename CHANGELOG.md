# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Type `@` in the composer to attach a file. A picker opens above the input and
  narrows as you type; `↑`/`↓` choose, `Enter` or `Tab` attaches, `Escape`
  dismisses. The workspace is walked once and cached, skipping `node_modules`
  and friends, and picks the most likely file first — an exact name beats a
  longer one starting the same, and a shallower path wins a tie.

### Changed

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