import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DiffManager } from './diffManager';
import { ReviewQueue } from './reviewQueue';
import { getGitHeadContent } from './git';

/**
 * Drains the pending-review count when Claude's changes get committed.
 *
 * Without this the status bar only ever shrinks on an explicit Accept/Reject
 * click, so committing a file leaves it counted as pending forever. Committing a
 * change *is* accepting it.
 *
 * The test is content equality against `HEAD` rather than "did a commit happen",
 * which keeps it correct for partial commits and for files committed from an
 * external terminal. It is deliberately conservative: a file that was committed
 * but has since picked up further edits still differs from `HEAD` and stays
 * pending.
 */
export class CommitReconciler implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly queue: ReviewQueue,
    private readonly diffManager: DiffManager,
    private readonly log: vscode.OutputChannel,
  ) {
    this.watchGit();
    // Fallback trigger for when the built-in git extension is unavailable or
    // disabled: a commit made elsewhere is usually followed by a return to VS Code.
    this.disposables.push(
      vscode.window.onDidChangeWindowState(state => { if (state.focused) { this.schedule(); } }),
    );
  }

  /** Reconciles after a short debounce — git state changes arrive in bursts. */
  schedule(delayMs = 300): void {
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => { this.timer = undefined; void this.reconcile(); }, delayMs);
  }

  async reconcile(): Promise<void> {
    for (const review of this.queue.pending()) {
      const filePath = review.filePath;

      if (!fs.existsSync(filePath)) {
        this.log.appendLine(`[reconcile] ${path.basename(filePath)} no longer on disk — clearing`);
        await this.diffManager.resolveSilently(filePath, true);
        continue;
      }

      const head = getGitHeadContent(filePath);
      if (head === undefined) { continue; } // Untracked — nothing has been committed

      let current: string;
      try {
        current = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      if (current !== head) { continue; }

      this.log.appendLine(`[reconcile] ${path.basename(filePath)} matches HEAD — treating as accepted`);
      await this.diffManager.resolveSilently(filePath, true);
    }
  }

  /**
   * Subscribes to the built-in git extension's repository state, which fires on
   * commits made outside VS Code as well as inside it.
   */
  private watchGit(): void {
    try {
      const ext = vscode.extensions.getExtension<any>('vscode.git');
      if (!ext) { return; }

      const attach = () => {
        const api = ext.exports?.getAPI?.(1);
        if (!api) { return; }
        const track = (repo: any) => {
          this.disposables.push(repo.state.onDidChange(() => this.schedule()));
        };
        for (const repo of api.repositories ?? []) { track(repo); }
        this.disposables.push(api.onDidOpenRepository?.(track) ?? { dispose() {} });
      };

      if (ext.isActive) { attach(); } else { void ext.activate().then(attach, () => undefined); }
    } catch (err) {
      this.log.appendLine(`[reconcile] git extension unavailable: ${String(err)}`);
    }
  }

  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    for (const d of this.disposables) { d.dispose(); }
    this.disposables.length = 0;
  }
}
