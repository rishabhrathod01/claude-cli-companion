import * as vscode from 'vscode';
import { ReviewQueue } from './reviewQueue';

export class StatusBarItem {
  private readonly item: vscode.StatusBarItem;

  constructor(queue: ReviewQueue) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.item.command = 'claudeDiff.showQueue';
    this.update(queue.pendingCount);
    queue.onDidChange(() => this.update(queue.pendingCount));
    this.item.show();
  }

  private update(count: number): void {
    if (count === 0) {
      this.item.text = '$(check) Claude';
      this.item.tooltip = 'No pending Claude reviews';
      this.item.backgroundColor = undefined;
    } else {
      this.item.text = `$(diff) Claude: ${count} pending`;
      this.item.tooltip = `${count} file(s) changed by Claude — click to review`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
  }

  dispose(): void { this.item.dispose(); }
}
