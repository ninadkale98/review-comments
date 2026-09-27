# Review Comments

Read through your code once, leaving comments as you go. Then hand every
comment to an AI agent in a single prompt.

## Usage

1. Select code (or put the cursor on a line) and press **⌘K C** / **Ctrl+K C**
2. Type what should change
3. Repeat across as many files as you like
4. Press **⌘K ⌘R** / **Ctrl+K Ctrl+R** — the whole batch is copied as a prompt

Paste it into Claude, Copilot, or any agent.

A commented line is marked in the gutter and the scrollbar, with a 💬 after it.
Hover the line to read the comment.

## Sessions

Comments collect into a session, created automatically with your first comment.
One is active at a time; only its comments are shown, so archiving a session
clears the markers.

The **Review Comments** panel in the Activity Bar lists everything by file.
Right-click a session to Rename, Clear, Archive, Delete, or Reopen it. The
status bar shows the count, with a **+** to start a new session.

Sessions are stored in VS Code's global storage, keyed to the workspace — never
inside your repository, so there is nothing to add to `.gitignore`.

## Settings

| Setting | Default | Description |
|---|---|---|
| `reviewComments.showStatusBar` | `true` | Show the count in the status bar |
| `reviewComments.promptHeader` | *(instruction line)* | Text at the top of the prompt |

## Scope

Works in any text file, including Markdown source. It does not add comments in
the rendered Markdown preview: a preview webview cannot send data back to an
extension, so there is no reliable way to do it.

## License

MIT
