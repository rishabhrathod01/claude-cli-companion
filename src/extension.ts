import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExplorerSender }          from './explorerSender';
import { PlanManager, PLANS_DIR } from './planManager';
import { OriginalContentProvider } from './originalProvider';
import { ReviewQueue }             from './reviewQueue';
import { DiffManager }             from './diffManager';
import { HookServer }              from './hookServer';
import { StatusBarItem }           from './statusBar';
import { PlanCodeLensProvider }    from './planCodeLens';

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
    // For files outside the workspace (e.g. plan files in ~/.claude/plans),
    // emit the absolute path so the CLI can still resolve the @file:lines ref.
    const relPath = workspaceFolder
      ? uri.fsPath.slice(workspaceFolder.uri.fsPath.length + 1)
      : uri.fsPath;

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

  // ── Explorer multi-select sender ──────────────────────────────────────────

  const explorerSender = new ExplorerSender(
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-cli-companion.sendFromExplorer',
      async (clickedUri: vscode.Uri, allSelectedUris: vscode.Uri[]) => {
        // When triggered from the context menu VS Code passes both args.
        // When triggered from a keybinding it passes neither — fall back to
        // the active text editor's URI so single-file Cmd+L still works.
        // Multi-selection via keybinding is not supported by VS Code's API;
        // users must right-click for multi-file sends.
        let uris: vscode.Uri[] =
          allSelectedUris?.length ? allSelectedUris : clickedUri ? [clickedUri] : [];

        if (!uris.length) {
          const activeUri = vscode.window.activeTextEditor?.document.uri;
          if (activeUri?.scheme === 'file') {
            uris = [activeUri];
          } else {
            vscode.window.showWarningMessage(
              'No file selected. Click a file in the Explorer or open one in the editor, then press Cmd+L. For multi-file sends, use right-click → "Send to Claude".',
            );
            return;
          }
        }

        const terminal = findClaudeTerminal();
        if (!terminal) {
          vscode.window.showWarningMessage(
            'No Claude terminal found. Use Cmd+Shift+L to open one first.',
          );
          return;
        }

        const refs = await explorerSender.resolveToFileRefs(uris);
        if (!refs) {
          vscode.window.showWarningMessage(
            'No files found in the selected items (excluded directories only?).',
          );
          return;
        }

        sendRefToTerminal(terminal, refs);
      },
    ),
  );

  // ── Diff review feature ───────────────────────────────────────────────────

  const diffConfig  = vscode.workspace.getConfiguration('claudeDiff');
  const port        = diffConfig.get<number>('port', 7878);
  const provider    = new OriginalContentProvider();
  const queue       = new ReviewQueue();
  const diffMgr     = new DiffManager(provider, queue);
  const planManager = new PlanManager(findClaudeTerminal, sendRefToTerminal);
  const hookServer  = new HookServer(diffMgr);
  const statusBar   = new StatusBarItem(queue);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(OriginalContentProvider.scheme, provider),
  );

  hookServer.start(port);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeDiff.acceptChanges', async () => {
      const fp = diffMgr.getActiveFilePath();
      if (fp) { await diffMgr.acceptChanges(fp); }
    }),
    vscode.commands.registerCommand('claudeDiff.rejectChanges', async () => {
      const fp = diffMgr.getActiveFilePath();
      if (fp) { await diffMgr.rejectChanges(fp); }
    }),
    vscode.commands.registerCommand('claudeDiff.acceptAll', () => diffMgr.acceptAll()),
    vscode.commands.registerCommand('claudeDiff.rejectAll',  () => diffMgr.rejectAll()),
    vscode.commands.registerCommand('claudeDiff.showQueue', async () => {
      const pending = queue.pending();
      if (pending.length === 0) {
        vscode.window.showInformationMessage('No pending Claude reviews.');
        return;
      }
      const selected = await vscode.window.showQuickPick(
        pending.map(r => ({
          label: path.basename(r.filePath),
          description: r.filePath,
          detail: `Changed at ${r.timestamp.toLocaleTimeString()}`,
          filePath: r.filePath,
        })),
        { placeHolder: 'Select a file to review' }
      );
      if (selected) { await diffMgr.openDiff(selected.filePath); }
    }),
    vscode.commands.registerCommand('claudeDiff.installHooks', () => installClaudeCodeHooks(port)),
    statusBar,
  );

  checkAndPromptHookInstall(port);

  // ── Plan viewer ───────────────────────────────────────────────────────────
  //
  // Claude Code writes plan-mode files to ~/.claude/plans/*.md. We watch that
  // directory and, when a new plan file appears, render it as source + markdown
  // preview so the user can select lines and send them back with Cmd+L. This is
  // fully self-contained — no hooks, jq, or curl required for plan capture.

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePlan.build',   () => planManager.buildActivePlan()),
    vscode.commands.registerCommand('claudePlan.discard', () => planManager.discardActivePlan()),
    // Register for all markdown; the provider filters to plan files by path.
    vscode.languages.registerCodeLensProvider(
      { language: 'markdown', scheme: 'file' },
      new PlanCodeLensProvider(),
    ),
  );

  const planWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(PLANS_DIR), '*.md'),
  );
  const openedPlans = new Set<string>();
  const renderPlanOnce = (uri: vscode.Uri) => {
    if (openedPlans.has(uri.fsPath)) { return; }
    openedPlans.add(uri.fsPath);
    void planManager.render(uri.fsPath);
  };
  // Fire on both create and the first change: depending on how the file is
  // written the create event can arrive empty (or not at all on rename).
  planWatcher.onDidCreate(renderPlanOnce);
  planWatcher.onDidChange(renderPlanOnce);
  context.subscriptions.push(planWatcher);
}

/** Called by VS Code when the extension is deactivated. All disposables registered via `context.subscriptions` are cleaned up automatically. */
export function deactivate() {}

// ── Hook installation helpers (outside activate) ──────────────────────────────

/**
 * Writes the PostToolUse hook entry into ~/.claude/settings.json so that
 * Claude Code automatically notifies the diff server when it edits a file.
 */
function installClaudeCodeHooks(port: number): void {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      vscode.window.showErrorMessage('Claude Diff: Could not parse ~/.claude/settings.json');
      return;
    }
  }

  if (!settings.hooks) { settings.hooks = {}; }
  if (!settings.hooks.PostToolUse) { settings.hooks.PostToolUse = []; }

  // Remove any existing entry written by this extension
  settings.hooks.PostToolUse = (settings.hooks.PostToolUse as any[]).filter(
    (entry: any) => !entry._claudeDiffReview
  );

  settings.hooks.PostToolUse.push({
    _claudeDiffReview: true,
    matcher: 'Edit|Write|MultiEdit',
    hooks: [
      {
        type: 'command',
        command: `jq -rc '{"filePath":(.tool_input.path//.tool_input.file_path//"")}|select(.filePath!="")' | curl -s -X POST http://127.0.0.1:${port}/file-changed -H 'Content-Type: application/json' -d @- || true`,
      },
    ],
  });

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    vscode.window.showInformationMessage(
      `Claude Diff: Hooks installed in ~/.claude/settings.json (port ${port}). ` +
      'Make sure jq and curl are available in your PATH.'
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Claude Diff: Failed to write settings — ${String(err)}`);
  }
}

/**
 * Checks whether the hook is already installed; if not, prompts the user once
 * per session to install it.
 */
function checkAndPromptHookInstall(port: number): void {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const hooks: any[] = settings?.hooks?.PostToolUse ?? [];
      if (hooks.some((e: any) => e._claudeDiffReview)) {
        return; // Already installed — nothing to do
      }
    }
  } catch {
    // If we can't read the file, fall through and offer to install
  }

  vscode.window.showInformationMessage(
    'Claude Diff: Install Claude Code hooks to enable automatic diff review?',
    'Install', 'Not Now'
  ).then(choice => {
    if (choice === 'Install') { installClaudeCodeHooks(port); }
  });
}
