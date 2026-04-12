import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Entry point called by VS Code when the extension is activated.
 * Registers the send-context commands and their keybindings.
 *
 * @param context - Extension context used to register disposables so they are
 *   cleaned up automatically when the extension is deactivated.
 */
export function activate(context: vscode.ExtensionContext) {
  /**
   * Builds a native Claude Code `@file:lines` reference from the active editor
   * state. Uses the cursor line when there is no selection, or the selected
   * line range otherwise. Claude Code resolves the reference before it reaches
   * the model — no tool call, no inline code, fewest possible tokens.
   *
   * @param editor - The active text editor supplying the document URI and selection.
   * @returns A string such as `@src/foo.ts:42` or `@src/foo.ts:10-25`.
   */
  function buildFileRef(editor: vscode.TextEditor): string {
    const uri = editor.document.uri;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const relPath = workspaceFolder
      ? uri.fsPath.slice(workspaceFolder.uri.fsPath.length + 1)
      : path.basename(uri.fsPath);

    const sel = editor.selection;
    const startLine = sel.start.line + 1;
    const endLine = sel.end.line + 1;

    return sel.isEmpty || startLine === endLine
      ? `@${relPath}:${startLine}`
      : `@${relPath}:${startLine}-${endLine}`;
  }

  /**
   * Writes `ref` into `terminal`'s input buffer without pressing Enter, then
   * shifts focus to the terminal so the user can append their prompt and submit.
   *
   * @param terminal - The target terminal to receive the reference.
   * @param ref - The `@file:lines` string to insert.
   */
  function sendRefToTerminal(terminal: vscode.Terminal, ref: string) {
    terminal.show(false);
    terminal.sendText(ref, false); // false = don't press Enter
    setTimeout(() => {
      vscode.commands.executeCommand('workbench.action.terminal.focus');
    }, 50);
  }

  /**
   * Finds the first open terminal whose name contains `"claude"` (case-insensitive).
   * Returns `undefined` when no matching terminal exists.
   */
  function findClaudeTerminal(): vscode.Terminal | undefined {
    return vscode.window.terminals.find((t) => t.name.toLowerCase().includes('claude'));
  }

  /**
   * Command handler for `Cmd+L` / `Ctrl+L`.
   * If text is selected, sends a `@file:lines` reference into the Claude terminal.
   * If nothing is selected, simply shifts focus to the terminal without inserting anything.
   * Shows a warning if no Claude terminal is found.
   */
  function handleSendContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const terminal = findClaudeTerminal();
    if (!terminal) {
      vscode.window.showWarningMessage(
        'No Claude terminal found. Open a terminal whose name includes "claude", then try again.',
      );
      return;
    }

    if (editor.selection.isEmpty) {
      terminal.show(false);
      vscode.commands.executeCommand('workbench.action.terminal.focus');
      return;
    }

    sendRefToTerminal(terminal, buildFileRef(editor));
  }

  /**
   * Command handler for `Cmd+Shift+L` / `Ctrl+Shift+L`.
   * Sends a `@file:lines` reference like {@link handleSendContext}, but also
   * creates a new terminal named `"claude code"` and starts the CLI when no
   * Claude terminal is currently open.
   */
  function handleOpenTerminalAndSendContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const ref = buildFileRef(editor);
    const terminal = findClaudeTerminal();

    if (!terminal) {
      const newTerminal = vscode.window.createTerminal('claude code');
      newTerminal.show(false);
      newTerminal.sendText('claude', true);
      setTimeout(() => sendRefToTerminal(newTerminal, ref), 2000);
    } else {
      sendRefToTerminal(terminal, ref);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-cli-companion.sendContext', handleSendContext),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-cli-companion.openTerminalAndSendContext',
      handleOpenTerminalAndSendContext,
    ),
  );
}

/** Called by VS Code when the extension is deactivated. All disposables registered via `context.subscriptions` are cleaned up automatically. */
export function deactivate() {}
