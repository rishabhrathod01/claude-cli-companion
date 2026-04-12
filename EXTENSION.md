# Extension Code Walkthrough

## Overview

The extension does two independent things:

1. **Send context** — in the editor, **`Cmd+L`** (`Ctrl+L` on Windows/Linux) sends a **bracketed label plus a code body** (current line or selection) into your Claude terminal. **`Cmd+Shift+L`** (`Ctrl+Shift+L`) sends **only the bracketed label** (reference line/character range). Both require an existing terminal whose name includes `claude` (case-insensitive).
2. **Diff on change** — when Claude modifies a file on disk, the extension automatically opens a diff view and asks you to Accept or Reject the change.

---

## Pieces of the Code

### `OriginalContentProvider`

```ts
class OriginalContentProvider implements vscode.TextDocumentContentProvider
```

VS Code's diff editor needs two URIs to compare — one for the left pane (before) and one for the right pane (after). The right pane is the real file on disk. The left pane is a **virtual document** served by this class.

When Claude modifies a file, we snapshot the old content and hand it to `OriginalContentProvider`. VS Code then calls `provideTextDocumentContent()` to render it in the diff left-pane. The URI scheme `claude-original:` is how VS Code knows to ask this provider instead of reading from disk.

---

### State Variables

Three variables coordinate the diff lifecycle:

| Variable | Type | Purpose |
|---|---|---|
| `contentCache` | `Map<string, string>` | Stores the last-known content of every saved file — this is the "before" snapshot |
| `pendingDiffs` | `Set<string>` | Tracks files that already have a diff open so we don't open duplicates |
| `externalWrites` | `Set<string>` | Marks files we're reverting ourselves so the file watcher doesn't loop |

---

### `onDidSaveTextDocument`

```ts
vscode.workspace.onDidSaveTextDocument((doc) => {
  contentCache.set(doc.uri.fsPath, doc.getText());
})
```

Every time you save a file in the editor, we update the cache. This ensures the "before" snapshot always reflects the last state *you* intentionally saved — not some intermediate state.

**Limitation:** files that are never opened in the editor won't be in the cache, so the diff won't trigger for them.

---

### File Watcher

```ts
vscode.workspace.createFileSystemWatcher('**/*', true, false, true)
```

The three flags mean: ignore creates, **watch changes**, ignore deletes. This fires whenever any file in the workspace changes on disk — including when Claude writes a file externally.

#### What happens on a change

```
File changes on disk
       ↓
Is it our own revert write? → skip
Is a diff already open?     → skip
Do we have a snapshot?       → skip if not
       ↓
Read new content from disk
Are old and new identical?   → skip
       ↓
Open diff editor (Before ↔ After)
Show Accept / Reject notification
       ↓
Reject → write old content back to disk
Accept → keep new content
       ↓
Close diff editor, clean up
```

#### The `?t=` query parameter trick

```ts
vscode.Uri.parse(`${SCHEME}:${fsPath}?t=${Date.now()}`)
```

VS Code caches the content of virtual URIs. Without a changing query string, the diff would show stale content if the same file is modified twice. The timestamp forces VS Code to request fresh content each time.

#### The `externalWrites` guard

When the user clicks Reject, we write the old content back to disk. This write triggers the file watcher again. Without the guard, the extension would open another diff — for its own revert. Adding the file path to `externalWrites` before writing, and removing it after a 1-second delay, prevents this loop.

---

### Send context commands

| Command | Default key | What is typed into the Claude terminal |
| --- | --- | --- |
| `claude-cli-companion.sendContext` | `Cmd+L` / `Ctrl+L` | `buildLabel` + newline + `buildBody` |
| `claude-cli-companion.openTerminalAndSendContext` | `Cmd+Shift+L` / `Ctrl+Shift+L` | `buildLabel` only |

#### VS Code: if `Cmd+L` does nothing

VS Code may bind **`Cmd+L`** to built-in **Chat** (or similar). Only one command wins that shortcut. Open **Keyboard Shortcuts**, search for `cmd+l`, and either **remove** the keybinding from the built-in command or ensure **Claude Code Context → Send File Context to Claude** is **above** it in priority so this extension runs.

Other editors based on VS Code can steal the same chord; the fix is the same idea in that product’s shortcut UI.

#### Building the label

The format mirrors Claude Code's `[Image #1]` pattern — a bracketed reference followed by the actual content:

```
[extension.ts:31-46:0-183]
const foo = ...
const bar = ...
```

| Situation | Label format | Code sent |
|---|---|---|
| No selection (cursor only) | `[filename:line]` | The full text of that line |
| Single-line selection | `[filename:line:startChar-endChar]` | Selected text |
| Multi-line selection | `[filename:startLine-endLine:startChar-endChar]` | Selected text |

For **multi-line** selections, `startChar-endChar` are **document offsets** from the start of the file (`TextDocument.offsetAt` for the selection start and end), in UTF-16 code units — matching a stable machine-readable range in the spirit of `[extension.ts:31-46:0-183]`.

The filename is just the base name (`extension.ts`), not the full path.

#### Finding the terminal

```ts
vscode.window.terminals.find((t) => t.name.toLowerCase().includes('claude'))
```

Searches all open terminals for one with "claude" in the name (case-insensitive). This matches terminals named `"claude"`, `"Claude Code"`, `"my-claude"`, etc.

**If a Claude terminal exists** — sends the payload immediately and focuses it.

**If no Claude terminal exists** — shows a warning; open or rename a terminal so its name includes `claude`, then run the command again.

#### Why `sendText(contextString, false)`

The second argument `false` means "don't append a newline / don't press Enter". This lets you keep typing additional context before submitting to Claude.

#### Focus after send

```ts
vscode.commands.executeCommand('workbench.action.terminal.focus');
```

`terminal.show(false)` makes the terminal panel visible but doesn't always move keyboard focus to the input line. The explicit focus command ensures you can start typing immediately after the snippet is inserted.

---

## Data Flow Diagram

```
User presses Cmd+L or Cmd+Shift+L
            │
            ▼
    Read active editor
    Build label (and body if Cmd+L)
            │
    ┌───────┴────────┐
    │ Claude terminal│
    │   exists?      │
    └───────┬────────┘
       No   │  Yes
       ▼    ▼
  Warning  Send to terminal (no Enter)
           Focus terminal input


Claude modifies a file on disk
            │
            ▼
    File watcher fires
            │
    Guards pass? (not revert, not pending, has snapshot)
            │
            ▼
    Read new content from disk
    Compare with contentCache
            │
            ▼
    Open diff editor (Before ↔ After)
    Show Accept / Reject notification
            │
    ┌───────┴────────┐
    │    Reject?     │
    └───────┬────────┘
       Yes  │  No
       ▼    ▼
  Write old  Keep new content
  content    Close diff
  back
  Close diff
```
