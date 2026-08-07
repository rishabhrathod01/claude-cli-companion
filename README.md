# [Claude CLI Companion](https://marketplace.visualstudio.com/items?itemName=rishabh-rathod.claude-cli-companion)

A VS Code extension for people who run the [Claude Code](https://claude.ai/code) CLI in a VS Code terminal.

It does three things:

1. **Send code to Claude** with a keybind, instead of copy-pasting.
2. **Track Claude's edits** in the status bar, and accept or reject them when you're ready.
3. **Read Claude's plans** as rendered markdown you can act on.

---

## 1. Send code to Claude

Select some lines and press `Cmd+L` (`Ctrl+L` on Windows/Linux).

The extension types `@src/app.ts:42-58` into the Claude terminal and hands you the keyboard, so you can finish the sentence: *"@src/app.ts:42-58 why does this re-render?"* It does **not** press Enter.

Why a reference instead of the code itself: Claude Code expands `@file:lines` on its own, before the model ever sees it. No tool call, no pasted block, far fewer tokens.

| You do this | You get |
|---|---|
| Select lines, `Cmd+L` | `@src/app.ts:42-58` |
| No selection, `Cmd+L` | Just jumps focus to the terminal |
| `Cmd+Shift+L` | Same as `Cmd+L`, but starts Claude first if it isn't running |
| Right-click files in the Explorer → **Send to Claude** | `@src/a.ts @src/b.ts @docs/` |

Folders are expanded to the files inside them, skipping `node_modules`, `.git`, `out`, `dist`, `.next`, and `build`.

---

## 2. Review Claude's edits

Claude's edits are tracked quietly. The status bar shows `Claude: N pending` and nothing interrupts you.

**Click the status bar** to get a menu:

![The review menu: Accept All, Reject All, a diff-view toggle, and the list of pending files](docs/review-menu.png)

- **View All Changes** — every pending file in a single scrollable diff, opened only when you ask for it
- **Accept All** / **Reject All** — clear the queue in one go. Reject restores each file to its `git HEAD` content.
- **Enable diff view** — turn on automatic diffs, if you'd rather see each change as it happens
- Or pick a single file to open just its diff, then **✓ Accept** / **↺ Reject** from the editor title bar

So the usual loop is: let Claude work uninterrupted, glance at the count, **View All Changes**, **Accept All**, done.

Automatic diffs are **off by default** — they interrupt the flow when Claude is editing several files in a row. Turn them on from that menu, or with **`Claude Diff: Toggle Diff View`**.

**Committing counts as accepting.** Commit a file and it disappears from the count, whether you committed in VS Code or in another terminal. A file you committed and then edited again still differs from `HEAD`, so it stays pending.

This one needs a one-time setup step — see [Setup](#setup).

---

## 3. Read Claude's plans

In plan mode, Claude writes its plan to `~/.claude/plans/`. The extension opens it as an editor tab with a live markdown preview beside it.

Because it's a normal editor tab, `Cmd+L` works on it:

- **Select part of the plan and press `Cmd+L`** to send just those steps back — "reconsider step 3" without resending the whole plan.
- **▶ Build Plan** sends the whole plan back and closes the tabs.
- **✕ Discard** closes the tabs and sends nothing.

Both buttons appear as links at the top of the plan and in the editor title bar. Either way the file stays on disk — it's Claude's artifact, not something this extension deletes.

---

## Multiple VS Code windows

`~/.claude/plans/` is one shared folder, and every open window can see it. Older versions opened every plan in every window.

Now each window works out which project the plan's Claude session belongs to, and only the matching window opens it. Same for diffs — a change is reviewed in the window whose workspace contains the edited file. If you have a repo and one of its git worktrees open side by side, the more specific window wins.

Plans and diffs also open in the editor group where your other files are, rather than on top of the Claude terminal.

**If Claude runs somewhere no window has open, nothing opens.** Run **`Claude: Open Latest Plan`** from the Command Palette to pull it up, or set `claudePlan.autoOpen` to `always` to go back to opening everywhere.

---

## Setup

1. Install the [Claude Code CLI](https://claude.ai/code) so `claude` is on your `PATH`.
2. Open a terminal in VS Code and run `claude`. (Or just press `Cmd+Shift+L` and let the extension open one.)
3. **For diff review only:** run **`Claude Diff: Install Claude Code Hooks`** from the Command Palette, or accept the prompt on first launch. This adds a `PostToolUse` hook to `~/.claude/settings.json` so Claude tells the extension when it edits a file. Needs `jq` and `curl` on your `PATH`.

Sending context and viewing plans need no setup.

> **Finding the terminal.** The extension looks for a terminal named `claude`, a shell integration reporting a running `claude` command, or a `claude` process under the terminal's shell — so a plain terminal you typed `claude` into works too. With several open, the focused one wins.

---

## Commands

| Command | What it does |
|---|---|
| `Send File Context to Claude` | Send the selection or cursor line as `@file:lines` |
| `Send File Context Label to Claude` | Same, starting Claude first if needed |
| `Send to Claude` | Send Explorer selection as `@path` references |
| `Claude: Open Latest Plan` | Open a recent plan here, whichever session wrote it |
| `Build Plan` | Send the whole plan back, then close its tabs |
| `Discard Plan` | Close the plan's tabs without sending |
| `Claude Diff: Accept Claude Changes` | Accept the open diff |
| `Claude Diff: Reject Claude Changes` | Revert the open diff to `git HEAD` |
| `Claude Diff: View All Pending Changes` | Open every pending file in one multi-file diff |
| `Claude Diff: Accept All Pending Changes` | Accept everything queued |
| `Claude Diff: Reject All Pending Changes` | Revert everything queued |
| `Claude Diff: Show Pending Review Queue` | Open the status bar menu — bulk actions and pending files |
| `Claude Diff: Toggle Diff View` | Turn automatic diffs on or off |
| `Claude Diff: Install Claude Code Hooks` | (Re)install the diff-review hook |

## Keybindings

| Key | Where | What |
|---|---|---|
| `Cmd+L` / `Ctrl+L` | Editor | Send selection to Claude |
| `Cmd+Shift+L` / `Ctrl+Shift+L` | Editor | Send selection, starting Claude if needed |
| `Cmd+L` / `Ctrl+L` | Explorer | Send the clicked file |

Multi-select only works via right-click — VS Code's API doesn't expose it to keybindings.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `claudePlan.autoOpen` | `owner` | Which window opens a plan. `owner` = only the matching one, `always` = all of them, `never` = none |
| `claudeDiff.autoOpenDiff` | `false` | Open the diff automatically when Claude edits a file |
| `claudeDiff.showNotifications` | `false` | With `autoOpenDiff` off, show a "Review Changes" notification per file instead |
| `claudeDiff.port` | `7878` | Preferred port for this window's hook server. Every window runs one, so a taken port just means an ephemeral one is used instead |

`Claude Diff: Toggle Diff View` writes `claudeDiff.autoOpenDiff` to your user settings, not the workspace — whether diffs pop open is a preference about how you work, not a property of one project.

---

## How it works

**Sending context** — the extension writes the reference into the terminal's input buffer and moves focus there. Nothing is submitted until you press Enter.

**Diff review** — the hook posts the changed file's path to a small server on `127.0.0.1` inside each VS Code window. The window that owns the file stashes its `git HEAD` content in memory and adds it to the queue; that stashed copy is what the diff renders against, and what rejecting writes back to disk. Nothing opens unless you ask, or unless the diff view is switched on. **View All Changes** uses VS Code's multi-file diff editor, falling back to one tab per file on older versions.

**Plans** — a file watcher on `~/.claude/plans/*.md` picks up new plans. To decide which window should open one, the extension reads the session's project directory out of Claude's own transcripts under `~/.claude/projects/` and compares it against the window's workspace folders.

Windows find each other through small JSON files in `~/.claude/claude-cli-companion/instances/`, one per running window, cleaned up on exit.

## Requirements

- [Claude Code CLI](https://claude.ai/code) on your `PATH`
- VS Code 1.85 or newer
- `jq` and `curl` — for diff review only
- `git` — diff review compares against `git HEAD`

## Known limits

- Diff review compares against the **last commit**, not against what the file looked like a second before Claude touched it. Uncommitted work of your own shows up in the diff too.
- Remote/WSL/SSH windows watch the *remote* `~/.claude`, so they only see sessions running on that host.
- The plan-owner lookup reads Claude's transcript files. If Claude ran from a directory no window has open, no window claims the plan — use `Claude: Open Latest Plan`.

## License

MIT
