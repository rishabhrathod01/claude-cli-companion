# [Claude CLI Companion](https://marketplace.visualstudio.com/items?itemName=rishabh-rathod.claude-cli-companion)

A VS Code extension that bridges your editor and the [Claude Code](https://claude.ai/code) CLI. Send precise file references to Claude with a single keybind, review its edits as diffs, and view plan-mode plans as rendered markdown you can select from and act on directly.

---

## Features

### Send file context to Claude (`Cmd+L` / `Ctrl+L`)

Press the keybind while your cursor is in the editor. The extension sends a native Claude Code `@file:lines` reference to your Claude terminal — no raw code pasted, minimum tokens, maximum accuracy.

- **No selection** — focuses the Claude terminal
- **Selection** — sends `@src/utils.ts:38-55` (line range)

Claude Code resolves the reference directly without an extra tool call, keeping your prompt clean and token-efficient. This works the same way in any markdown file, including rendered plans (see below) — the reference uses the file's absolute path when it's outside the current workspace.

### Open Claude terminal and send context (`Cmd+Shift+L` / `Ctrl+Shift+L`)

Same as above, but creates a new terminal named `claude code` and starts the Claude CLI automatically if no Claude terminal is open yet.

### Send files from the Explorer (`Cmd+L` / `Ctrl+L`, or right-click)

Select one or more files or folders in the Explorer and send them as `@path` references:

- **Right-click → "Send to Claude"** — supports multi-select; folders are expanded recursively (skipping `node_modules`, `.git`, `out`, `dist`, `.next`, `build`)
- **`Cmd+L` / `Ctrl+L`** while the Explorer has focus — sends the currently clicked item (single-file only; use right-click for multi-select)

### Plan viewer — render Claude's plan-mode output as markdown

When Claude Code is in **plan mode**, it writes the plan to a markdown file under `~/.claude/plans/`. This extension watches that directory and automatically opens each new plan as a normal editor tab with the **native markdown preview** to the side — so you get a readable, rendered view of the plan the moment it's written.

Because the plan opens in a regular editor, everything you already know works on it:

- **Select any portion of the plan and press `Cmd+L` / `Ctrl+L`** to send just those lines back to the Claude terminal as an `@path:startLine-endLine` reference — ask Claude to refine, expand, or reconsider a specific step without resending the whole plan.
- Two actions are available both as **CodeLens links at the top of the plan** and as **buttons in the editor title bar**:
  - **▶ Build Plan** — sends the entire plan to the Claude terminal as a full-file reference (`@path:1-N`) and closes the plan's editor/preview tabs.
  - **✕ Discard** — closes the plan's editor/preview tabs without sending anything.

The plan file itself is left on disk under `~/.claude/plans/` either way — it's Claude Code's own session artifact, not something this extension deletes.

**With several VS Code windows open, only the right one opens the plan.** `~/.claude/plans/` is a single shared directory, so every window sees every plan. The extension figures out which project the plan's Claude session belongs to — by reading the session root from Claude's own transcript under `~/.claude/projects/` — and renders it only in the window whose workspace folder contains it. Nested cases resolve to the most specific window, so a plan written in a git worktree opens in the worktree's window rather than the repo root's.

If Claude was run from a directory that no open window has, no window opens the plan. Run **`Claude: Open Latest Plan`** from the Command Palette to pull it up anyway, or set `claudePlan.autoOpen` to `always` to restore the old open-everywhere behaviour.

> Plan files never trigger the diff-review feature below, even though Claude writes them with the same `Write` tool — the extension always renders `~/.claude/plans/*.md` as a plan, not a diff.

### Diff review — Accept / Reject Claude's file edits

When Claude edits a file in your workspace (`Edit`, `Write`, or `MultiEdit`), the extension can automatically open a diff view comparing the file's last commit (`git HEAD`) against the new on-disk content, so you can review before trusting the change.

- **✓ Accept** — keeps the change on disk, marks it resolved
- **↺ Reject** — reverts the file to its `git HEAD` content
- **Accept All / Reject All** — resolve every pending review at once
- **Show Pending Review Queue** — pick from a list of files Claude has changed that you haven't reviewed yet
- A status bar item shows `$(check) Claude` when there's nothing pending, or `$(diff) Claude: N pending` otherwise — click it to open the queue

**Committing a file clears it from the count.** Committing a change is accepting it, so the extension watches your repository and drops any pending review whose file now matches `git HEAD` — including commits made from an outside terminal. A file that was committed but has picked up further edits since still differs from `HEAD`, so it stays pending.

**Diffs open in the window that owns the file.** Every window runs its own hook server on its own port and registers itself, so a change is reviewed in the window whose workspace folder contains the edited file — not in whichever window happened to start first.

This feature requires a one-time hook installed into Claude Code's own settings (see **Setup** below); without it, edits still happen, they just won't trigger an automatic diff.

---

## Setup

1. Install [Claude Code CLI](https://claude.ai/code) and make sure `claude` is on your `PATH`.
2. Open a terminal in VS Code and start Claude Code — name or rename the terminal tab so it contains the word `claude` (the CLI does this by default), or just use `Cmd+Shift+L` to have the extension create one for you.
3. To enable diff review, run **`Claude Diff: Install Claude Code Hooks`** from the Command Palette (or accept the one-time prompt that appears on first activation). This writes a `PostToolUse` hook into `~/.claude/settings.json` that notifies the extension's local hook server whenever Claude edits a file. Requires `jq` and `curl` to be available in your `PATH`.
4. Plan viewing needs no setup — it works as soon as Claude Code writes a file under `~/.claude/plans/`.

---

## Requirements

- [Claude Code CLI](https://claude.ai/code) installed and accessible as `claude` in your `PATH`
- A terminal open in VS Code running Claude Code
- `jq` and `curl` on your `PATH` — only needed for the diff-review hook

> **Note:** The extension finds the Claude terminal by the terminal name containing `claude`, by shell integration reporting a running `claude` command, or by spotting a `claude` process under the terminal's shell — so a plain terminal you typed `claude` into is found too. When more than one qualifies, the focused terminal wins. If `Cmd+L` still shows a "no terminal found" warning, use `Cmd+Shift+L` to have the extension open and name one for you.

---

## Commands

| Command | What it does |
|---|---|
| `Send File Context to Claude` | Send the active selection/cursor line as `@file:lines` |
| `Send File Context Label to Claude` | Same, opening/starting a Claude terminal first if needed |
| `Send to Claude` | Send selected Explorer file(s)/folder(s) as `@path` references |
| `Claude Diff: Accept Claude Changes` | Accept the change in the currently open diff |
| `Claude Diff: Reject Claude Changes` | Revert the currently open diff to `git HEAD` |
| `Claude Diff: Accept All Pending Changes` | Accept every pending review |
| `Claude Diff: Reject All Pending Changes` | Revert every pending review |
| `Claude Diff: Show Pending Review Queue` | Pick a pending file to review |
| `Claude Diff: Install Claude Code Hooks` | (Re)install the `PostToolUse` hook used for diff review |
| `Build Plan` | Send the active plan file to Claude in full, then close its tabs |
| `Discard Plan` | Close the active plan file's tabs without sending it |
| `Claude: Open Latest Plan` | Open a recent plan in this window regardless of which session wrote it |

---

## Keybindings

| Action | macOS | Windows / Linux | Context |
|---|---|---|---|
| Send context to Claude | `Cmd+L` | `Ctrl+L` | Editor focused |
| Open Claude terminal & send context | `Cmd+Shift+L` | `Ctrl+Shift+L` | Editor focused |
| Send selected file(s) to Claude | `Cmd+L` | `Ctrl+L` | Explorer focused |

> **Note:** `Cmd+L` / `Ctrl+L` is bound to **Expand Line Selection** in VS Code by default. To use this extension's binding, open **Keyboard Shortcuts** (`Cmd+K Cmd+S`), search for `expandLineSelection`, and remove or rebind that entry.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeDiff.port` | `7878` | Preferred port for this window's hook server. Every window runs one, so when the port is taken an ephemeral one is used instead — the hook finds each window through its registry entry, not a fixed port |
| `claudeDiff.autoOpenDiff` | `true` | Automatically open the diff view when Claude edits a file |
| `claudeDiff.showNotifications` | `true` | Show a notification (with a "Review Changes" action) instead of auto-opening, when `autoOpenDiff` is off |
| `claudePlan.autoOpen` | `owner` | Which window opens a plan. `owner` = only the window owning the Claude session; `always` = every window; `never` = none (use `Claude: Open Latest Plan`) |

---

## How it works

**Sending context:**
1. Select lines in the editor (or a file in the Explorer)
2. Press `Cmd+L` — the extension writes `@src/yourfile.ts:startLine-endLine` (or `@path`) into the Claude terminal input, without pressing Enter
3. Finish typing your prompt and submit
4. Claude reads the exact lines/files referenced and responds

**Reviewing edits:**
1. Claude edits a file via `Edit`/`Write`/`MultiEdit`
2. The installed hook notifies the extension's local server
3. The extension snapshots the file's `git HEAD` content and opens a Before ↔ After diff
4. You Accept (keep) or Reject (revert to `HEAD`)

**Viewing a plan:**
1. Claude Code enters plan mode and writes its plan to `~/.claude/plans/<name>.md`
2. The extension detects the new file and opens it as source + rendered markdown preview
3. Select any part of the plan and press `Cmd+L` to send just that portion back to Claude — or click **Build Plan** to send the whole thing

---

## Release Notes

### 0.0.4 (current)

- **Plan viewer** — automatically renders Claude Code plan-mode files (`~/.claude/plans/*.md`) as markdown with a live preview; select any portion and send it back with `Cmd+L`; **Build Plan** / **Discard** available as CodeLens links in the document and as editor title-bar buttons
- Diff review now ignores files under `~/.claude/plans/` so plans never get mistaken for a code edit to review
- **Diff review** — Accept/Reject/Accept All/Reject All, pending review queue, status bar indicator, one-click hook installation
- **Send from Explorer** — multi-select files/folders via right-click, or single-file via `Cmd+L` with the Explorer focused

### 0.0.1

Initial release.

- `@file:lines` reference format for token-efficient context passing
- Auto-create Claude terminal on `Cmd+Shift+L`
