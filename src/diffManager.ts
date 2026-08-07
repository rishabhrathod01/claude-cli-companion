import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { OriginalContentProvider } from './originalProvider';
import { ReviewQueue } from './reviewQueue';
import { getGitHeadContent } from './git';
import { targetViewColumnOrBeside } from './editorGroups';
import { isPlanFile } from './planManager';

export class DiffManager {
  constructor(
    private readonly provider: OriginalContentProvider,
    private readonly queue: ReviewQueue,
  ) {}

  async onFileChanged(filePath: string): Promise<void> {
    console.log(`[claude-diff] onFileChanged: ${filePath}`);
    // Plan-mode files live in ~/.claude/plans and are handled by the plan
    // viewer (rendered as markdown), not the diff-review flow.
    if (isPlanFile(filePath)) {
      console.log(`[claude-diff] ignoring plan file: ${filePath}`);
      return;
    }
    const config = vscode.workspace.getConfiguration('claudeDiff');
    // Both default off: a change is recorded in the status bar without opening
    // anything or interrupting. Opt in via 'Claude Diff: Toggle Diff View'.
    const autoOpen = config.get<boolean>('autoOpenDiff', false);
    const showNotifications = config.get<boolean>('showNotifications', false);
    console.log(`[claude-diff] config: autoOpenDiff=${autoOpen}, showNotifications=${showNotifications}`);

    const headContent = getGitHeadContent(filePath) ?? '';
    console.log(`[claude-diff] git HEAD content length: ${headContent.length} chars`);
    this.provider.store(filePath, headContent);
    this.queue.add(filePath);
    console.log(`[claude-diff] queue size: ${this.queue.pendingCount}`);

    if (autoOpen) {
      console.log(`[claude-diff] calling openDiff`);
      await this.openDiff(filePath);
    } else if (showNotifications) {
      const action = await vscode.window.showInformationMessage(
        `Claude edited: ${path.basename(filePath)}`, 'Review Changes'
      );
      if (action === 'Review Changes') { await this.openDiff(filePath); }
    }
  }

  async openDiff(filePath: string): Promise<void> {
    console.log(`[claude-diff] openDiff: ${filePath}`);
    await vscode.commands.executeCommand('setContext', 'claudeDiff.isDiffOpen', true);
    const uri = vscode.Uri.file(filePath);
    const originalUri = this.provider.makeUri(filePath);
    console.log(`[claude-diff] original URI: ${originalUri.toString()}`);
    // Open beside the user's code, not on top of the Claude terminal — when the
    // CLI runs as an editor-area terminal, the active group is the terminal's.
    await vscode.commands.executeCommand(
      'vscode.diff', originalUri, uri,
      `Claude: ${path.basename(filePath)} (Before ↔ After)`,
      { preview: false, viewColumn: targetViewColumnOrBeside(isPlanFile) }
    );
    console.log(`[claude-diff] vscode.diff command completed`);
  }

  async acceptChanges(filePath: string): Promise<void> {
    // Changes are already on disk — just mark resolved and close
    await this.resolveSilently(filePath, true);
    vscode.window.showInformationMessage(`Accepted changes to ${path.basename(filePath)}`);
    await this.openNextPending();
  }

  /**
   * Drops a file from the review queue and closes its diff without notifying the
   * user. Used by the commit reconciler, where the resolution is inferred rather
   * than requested — a toast per committed file would be noise.
   */
  async resolveSilently(filePath: string, accepted: boolean): Promise<void> {
    this.queue.resolve(filePath, accepted);
    this.provider.clear(filePath);
    await this.closeDiff(filePath);
  }

  async rejectChanges(filePath: string): Promise<void> {
    const original = this.provider.retrieve(filePath);
    if (original !== undefined) { fs.writeFileSync(filePath, original, 'utf8'); }
    this.queue.resolve(filePath, false);
    this.provider.clear(filePath);
    await this.closeDiff(filePath);
    vscode.window.showInformationMessage(`Reverted changes to ${path.basename(filePath)}`);
    await this.openNextPending();
  }

  async acceptAll(): Promise<void> {
    const pending = this.queue.pending();
    for (const item of pending) {
      this.queue.resolve(item.filePath, true);
      this.provider.clear(item.filePath);
    }
    await this.closeAllDiffs();
    vscode.window.showInformationMessage(`Accepted all ${pending.length} Claude changes`);
  }

  async rejectAll(): Promise<void> {
    const pending = this.queue.pending();
    for (const item of pending) {
      const original = this.provider.retrieve(item.filePath);
      if (original !== undefined) { fs.writeFileSync(item.filePath, original, 'utf8'); }
      this.queue.resolve(item.filePath, false);
      this.provider.clear(item.filePath);
    }
    await this.closeAllDiffs();
    vscode.window.showInformationMessage(`Reverted all ${pending.length} Claude changes`);
  }

  getActiveFilePath(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri) { return undefined; }
    if (uri.scheme === 'file') { return uri.fsPath; }
    if (uri.scheme === OriginalContentProvider.scheme) { return uri.path; }
    return undefined;
  }

  private async openNextPending(): Promise<void> {
    const next = this.queue.pending()[0];
    if (next) { await this.openDiff(next.filePath); }
  }

  private async closeDiff(filePath: string): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as any;
        if (input?.modified?.fsPath === filePath) { await vscode.window.tabGroups.close(tab); }
      }
    }
    if (this.queue.pendingCount === 0) {
      await vscode.commands.executeCommand('setContext', 'claudeDiff.isDiffOpen', false);
    }
  }

  private async closeAllDiffs(): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as any;
        if (input?.original?.scheme === OriginalContentProvider.scheme) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
    await vscode.commands.executeCommand('setContext', 'claudeDiff.isDiffOpen', false);
  }
}
