# [Claude CLI Companion](https://marketplace.visualstudio.com/items?itemName=rishabh-rathod.claude-cli-companion)

A VS Code extension that bridges your editor and the [Claude Code](https://claude.ai/code) CLI. Send precise file references to Claude with a single keybind.

---

## Features

### Send file context to Claude (`Cmd+L` / `Ctrl+L`)

Press the keybind while your cursor is in the editor. The extension sends a native Claude Code `@file:lines` reference to your Claude terminal — no raw code pasted, minimum tokens, maximum accuracy.

- **No selection** — focuses the Claude terminal
- **Selection** — sends `@src/utils.ts:38-55` (line range)

Claude Code resolves the reference directly without an extra tool call, keeping your prompt clean and token-efficient.

### Open Claude terminal and send context (`Cmd+Shift+L` / `Ctrl+Shift+L`)

Same as above, but creates a new terminal named `claude code` and starts the Claude CLI automatically if no Claude terminal is open yet.

---

## Requirements

- [Claude Code CLI](https://claude.ai/code) installed and accessible as `claude` in your `PATH`
- A terminal open in VS Code whose name contains `claude` (case-insensitive) — the CLI names its terminal `Claude` by default

> **Note:** The extension identifies the Claude terminal by looking for the word `claude` in the terminal name. If `Cmd+L` shows a "no terminal found" warning, check that Claude Code is running and its terminal tab is named something containing `claude`. Use `Cmd+Shift+L` to automatically create and name a terminal correctly if one isn't open yet.

---

## Keybindings

| Action | macOS | Windows / Linux |
|---|---|---|
| Send context to Claude | `Cmd+L` | `Ctrl+L` |
| Open Claude terminal & send context | `Cmd+Shift+L` | `Ctrl+Shift+L` |

Both shortcuts trigger only when the text editor has focus (`editorTextFocus`).

> **Note:** `Cmd+L` / `Ctrl+L` is bound to **Expand Line Selection** in VS Code by default. To use this extension's binding, open **Keyboard Shortcuts** (`Cmd+K Cmd+S`), search for `expandLineSelection`, and remove or rebind that entry.

---

## How it works

1. Select lines in the editor
2. Press `Cmd+L` — the extension writes `@src/yourfile.ts:startLine-endLine` into the Claude terminal input (without pressing Enter)
3. Finish typing your prompt and submit
4. Claude reads the exact lines referenced and responds

---

## Release Notes

### 0.0.1

Initial release.

- `@file:lines` reference format for token-efficient context passing
- Auto-create Claude terminal on `Cmd+Shift+L`
