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
import { ClaudeTerminalTracker }   from './claudeTerminals';
import { CommitReconciler }        from './commitReconciler';
import { InstanceRegistry }        from './instanceRegistry';
import { PlanAutoOpen, PlanRouter } from './planOwnership';

/**
 * Version of the hook entry this extension writes into ~/.claude/settings.json.
 * Bumped whenever the command changes so older entries are rewritten in place.
 */
const HOOK_VERSION = 2;

/** Set in {@link activate} so {@link deactivate} can tear down cross-window state. */
let registryRef: InstanceRegistry | undefined;
let hookServerRef: HookServer | undefined;

/**
 * Entry point called by VS Code when the extension is activated.
 * Registers the send-context commands and their keybindings.
 *
 * @param context - Extension context used to register disposables so they are
 *   cleaned up automatically when the extension is deactivated.
 */
export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Claude CLI Companion');
  context.subscriptions.push(log);

  const terminals = new ClaudeTerminalTracker(log);
  context.subscriptions.push(terminals);

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
   * Finds the terminal running Claude Code in this window, or `undefined`.
   * See {@link ClaudeTerminalTracker} for the signals it considers.
   */
  function findClaudeTerminal(): vscode.Terminal | undefined {
    return terminals.find();
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
  const statusBar   = new StatusBarItem(queue);
  const reconciler  = new CommitReconciler(queue, diffMgr, log);

  // Makes this window visible to its siblings: the plan router reads every other
  // window's folders to settle ownership, and the hook uses the recorded port.
  const registry = new InstanceRegistry(log);
  registry.start();
  registryRef = registry;

  const planRouter = new PlanRouter({
    planManager,
    registry,
    getMode: () => vscode.workspace
      .getConfiguration('claudePlan')
      .get<PlanAutoOpen>('autoOpen', 'owner'),
    log,
  });

  const hookServer = new HookServer(
    diffMgr,
    (planPath, cwd) => void planRouter.handle(planPath, cwd),
    log,
  );
  hookServerRef = hookServer;

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(OriginalContentProvider.scheme, provider),
    registry,
    hookServer,
    reconciler,
  );

  void hookServer.start(port).then(bound => {
    if (bound !== undefined) {
      registry.setPort(bound);
      log.appendLine(`[hook] listening on 127.0.0.1:${bound}`);
    }
  });

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
    vscode.commands.registerCommand('claudeDiff.installHooks', () => installClaudeCodeHooks()),
    statusBar,
  );

  checkAndPromptHookInstall(log);

  // ── Plan viewer ───────────────────────────────────────────────────────────
  //
  // Claude Code writes plan-mode files to ~/.claude/plans/*.md. We watch that
  // directory and, when a new plan file appears, render it as source + markdown
  // preview so the user can select lines and send them back with Cmd+L. This is
  // fully self-contained — no hooks, jq, or curl required for plan capture.
  //
  // Every open VS Code window watches the same directory, so the render itself
  // goes through PlanRouter, which renders only in the window that owns the
  // session that wrote the plan.

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePlan.build',   () => planManager.buildActivePlan()),
    vscode.commands.registerCommand('claudePlan.discard', () => planManager.discardActivePlan()),
    vscode.commands.registerCommand('claudePlan.openLatest', () => openLatestPlan(planRouter)),
    // Register for all markdown; the provider filters to plan files by path.
    vscode.languages.registerCodeLensProvider(
      { language: 'markdown', scheme: 'file' },
      new PlanCodeLensProvider(),
    ),
  );

  // A non-recursive watcher on a directory that does not exist silently never
  // fires, so make sure it is there before watching.
  try {
    fs.mkdirSync(PLANS_DIR, { recursive: true });
  } catch (err) {
    log.appendLine(`[plan] could not create ${PLANS_DIR}: ${String(err)}`);
  }

  const planWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(PLANS_DIR), '*.md'),
  );
  const routePlan = (uri: vscode.Uri) => void planRouter.handle(uri.fsPath);
  // Fire on both create and the first change: depending on how the file is
  // written the create event can arrive empty (or not at all on rename).
  planWatcher.onDidCreate(routePlan);
  planWatcher.onDidChange(routePlan);
  context.subscriptions.push(planWatcher);
}

/**
 * Called by VS Code when the extension is deactivated. Disposables registered via
 * `context.subscriptions` are cleaned up automatically, but the instance record
 * and the hook server are also torn down explicitly so a sibling window never
 * sees this one as live.
 */
export function deactivate() {
  hookServerRef?.stop();
  hookServerRef = undefined;
  registryRef?.dispose();
  registryRef = undefined;
}

// ── Plan escape hatch ─────────────────────────────────────────────────────────

/**
 * Opens a plan on explicit request, bypassing ownership.
 *
 * When Claude runs from a directory no window has open, no window claims the
 * plan — deliberately, since picking an arbitrary window is the bug this routing
 * exists to fix. This command is how the user retrieves it anyway.
 */
async function openLatestPlan(router: PlanRouter): Promise<void> {
  let plans: Array<{ file: string; mtime: number }>;
  try {
    plans = fs.readdirSync(PLANS_DIR)
      .filter(name => name.endsWith('.md'))
      .map(name => {
        const file = path.join(PLANS_DIR, name);
        return { file, mtime: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10);
  } catch {
    plans = [];
  }

  if (plans.length === 0) {
    vscode.window.showInformationMessage('No Claude plans found in ~/.claude/plans.');
    return;
  }

  if (plans.length === 1) {
    await router.renderExplicitly(plans[0].file);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    plans.map(p => ({
      label: path.basename(p.file, '.md'),
      description: new Date(p.mtime).toLocaleString(),
      file: p.file,
    })),
    { placeHolder: 'Select a Claude plan to open' },
  );
  if (picked) { await router.renderExplicitly(picked.file); }
}

// ── Hook installation helpers (outside activate) ──────────────────────────────

/**
 * The shell the hook runs. It broadcasts the tool payload to every window
 * registered in the instance directory; each window then decides for itself
 * whether the change belongs to it.
 *
 * Fanning out beats routing here for two reasons: the ownership rule stays in
 * TypeScript instead of being duplicated in shell, and the command contains no
 * path into the extension install directory — which would otherwise break on
 * every version bump. Dependencies are still just jq and curl.
 */
const HOOK_COMMAND = [
  `p=$(jq -rc '{filePath:(.tool_input.file_path//.tool_input.path//""),cwd:(.cwd//""),transcriptPath:(.transcript_path//"")}|select(.filePath!="")')`,
  `[ -n "$p" ] && for f in "$HOME"/.claude/claude-cli-companion/instances/*.json; do`,
  `  [ -e "$f" ] || continue`,
  `  port=$(jq -r '.port // empty' "$f")`,
  // -m 1 bounds the cost of a registry entry whose window died between the
  // liveness prune and this call.
  `  [ -n "$port" ] && curl -s -m 1 -X POST "http://127.0.0.1:$port/file-changed" -H 'Content-Type: application/json' -d "$p" >/dev/null`,
  `done; true`,
].join('\n');

/**
 * Writes the PostToolUse hook entry into ~/.claude/settings.json so that
 * Claude Code automatically notifies the diff server when it edits a file.
 *
 * @param announce - Whether to confirm with a notification. Suppressed when the
 *   call is a silent in-place upgrade of an entry the user already accepted.
 */
function installClaudeCodeHooks(announce = true): void {
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

  // Remove any existing entry written by this extension, at any version
  settings.hooks.PostToolUse = (settings.hooks.PostToolUse as any[]).filter(
    (entry: any) => !entry._claudeDiffReview
  );

  settings.hooks.PostToolUse.push({
    _claudeDiffReview: HOOK_VERSION,
    matcher: 'Edit|Write|MultiEdit',
    hooks: [{ type: 'command', command: HOOK_COMMAND }],
  });

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    if (announce) {
      vscode.window.showInformationMessage(
        'Claude Diff: Hooks installed in ~/.claude/settings.json. ' +
        'Make sure jq and curl are available in your PATH.'
      );
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Claude Diff: Failed to write settings — ${String(err)}`);
  }
}

/**
 * Installs the hook, prompting first when there is nothing there yet.
 *
 * An entry this extension wrote at an older version is upgraded in place without
 * asking: the user already consented to it, and re-prompting on every release
 * would be noise.
 */
function checkAndPromptHookInstall(log: vscode.OutputChannel): void {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const hooks: any[] = settings?.hooks?.PostToolUse ?? [];
      const existing = hooks.find((e: any) => e._claudeDiffReview);
      if (existing) {
        // `true` was the v1 marker, before versions were tracked.
        const version = existing._claudeDiffReview === true ? 1 : Number(existing._claudeDiffReview);
        if (version < HOOK_VERSION) {
          log.appendLine(`[hook] upgrading settings.json entry v${version} -> v${HOOK_VERSION}`);
          installClaudeCodeHooks(false);
        }
        return;
      }
    }
  } catch {
    // If we can't read the file, fall through and offer to install
  }

  vscode.window.showInformationMessage(
    'Claude Diff: Install Claude Code hooks to enable automatic diff review?',
    'Install', 'Not Now'
  ).then(choice => {
    if (choice === 'Install') { installClaudeCodeHooks(); }
  });
}
