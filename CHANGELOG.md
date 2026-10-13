# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

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