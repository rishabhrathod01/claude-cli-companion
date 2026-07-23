import * as vscode from 'vscode';

export interface PendingReview {
  filePath: string;
  timestamp: Date;
  accepted?: boolean; // undefined = pending, true = accepted, false = rejected
}

export class ReviewQueue {
  private queue: PendingReview[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  add(filePath: string): void {
    const existing = this.queue.find(r => r.filePath === filePath);
    if (existing) {
      existing.timestamp = new Date();
      existing.accepted = undefined;
    } else {
      this.queue.push({ filePath, timestamp: new Date() });
    }
    this._onDidChange.fire();
  }

  pending(): PendingReview[] {
    return this.queue.filter(r => r.accepted === undefined);
  }

  resolve(filePath: string, accepted: boolean): void {
    const item = this.queue.find(r => r.filePath === filePath);
    if (item) { item.accepted = accepted; this._onDidChange.fire(); }
  }

  get pendingCount(): number {
    return this.pending().length;
  }
}
