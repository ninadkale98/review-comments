# Change Log

## [0.2.0]

Simplified.

- Removed Markdown preview support: the preview cannot return data to an
  extension, and the workarounds were unreliable.
- Replaced the Comments API with editor decorations and a hover, so VS Code's
  Comments panel no longer opens at the bottom of the window.
- Removed comment re-anchoring; comments keep the line they were made on.
- No clipboard access except the explicit Copy Prompt command.

## [0.1.0]

Initial release.
