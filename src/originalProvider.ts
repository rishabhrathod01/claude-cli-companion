import * as vscode from 'vscode';

export class OriginalContentProvider implements vscode.TextDocumentContentProvider {
  private static readonly SCHEME = 'claude-original';
  private originals = new Map<string, string>();

  static get scheme() { return this.SCHEME; }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.originals.get(uri.path) ?? '';
  }

  store(filePath: string, content: string): void {
    this.originals.set(filePath, content);
  }

  retrieve(filePath: string): string | undefined {
    return this.originals.get(filePath);
  }

  clear(filePath: string): void {
    this.originals.delete(filePath);
  }

  makeUri(filePath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: OriginalContentProvider.SCHEME, path: filePath });
  }
}
