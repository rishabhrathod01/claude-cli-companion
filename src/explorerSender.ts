import * as path from 'path';
import * as vscode from 'vscode';

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.next', 'build']);

/**
 * Resolves a mixed set of file/folder URIs selected in the VS Code Explorer
 * into a flat, deduplicated list of workspace-relative `@file` references
 * suitable for pasting into a Claude terminal.
 */
export class ExplorerSender {
  constructor(private readonly workspaceRoot: string | undefined) {}

  /**
   * Converts an array of file/folder URIs into a space-separated string of
   * `@relative/path` references. Folders are recursively expanded; duplicates
   * (e.g. a file selected both directly and via its parent folder) are removed.
   */
  async resolveToFileRefs(uris: vscode.Uri[]): Promise<string> {
    const files = await this.flattenToFiles(uris);
    return files.map((uri) => `@${this.relPath(uri)}`).join(' ');
  }

  /**
   * Stats each URI, collects plain files directly, and recursively expands
   * directories. Deduplicates by `fsPath` so the same file never appears twice.
   */
  private async flattenToFiles(uris: vscode.Uri[]): Promise<vscode.Uri[]> {
    const seen = new Set<string>();
    const result: vscode.Uri[] = [];

    const collect = async (uri: vscode.Uri) => {
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        // URI no longer exists or is inaccessible — skip silently
        return;
      }

      if (stat.type === vscode.FileType.Directory) {
        const children = await this.expandDirectory(uri);
        for (const child of children) {
          if (!seen.has(child.fsPath)) {
            seen.add(child.fsPath);
            result.push(child);
          }
        }
      } else {
        // Plain file (or symlink to file)
        if (!seen.has(uri.fsPath)) {
          seen.add(uri.fsPath);
          result.push(uri);
        }
      }
    };

    await Promise.all(uris.map(collect));
    return result;
  }

  /**
   * Recursively enumerates all files under `uri`, skipping any directory whose
   * name appears in `EXCLUDED_DIRS`. Uses `vscode.workspace.fs` so it works on
   * remote workspaces (SSH, Codespaces, WSL) without any local `fs` calls.
   */
  private async expandDirectory(uri: vscode.Uri): Promise<vscode.Uri[]> {
    const result: vscode.Uri[] = [];

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      return result;
    }

    await Promise.all(
      entries.map(async ([name, type]) => {
        const childUri = vscode.Uri.joinPath(uri, name);

        if (type === vscode.FileType.Directory) {
          if (EXCLUDED_DIRS.has(name)) {
            return;
          }
          const nested = await this.expandDirectory(childUri);
          result.push(...nested);
        } else {
          // Include plain files and symlinks
          result.push(childUri);
        }
      }),
    );

    return result;
  }

  /**
   * Returns the workspace-relative path for `uri`. Falls back to the absolute
   * path when the file lives outside any workspace folder (mirrors the logic in
   * `buildFileRef` in extension.ts).
   */
  private relPath(uri: vscode.Uri): string {
    if (this.workspaceRoot) {
      const rel = path.relative(this.workspaceRoot, uri.fsPath);
      // path.relative returns an absolute-looking string when crossing drives on
      // Windows; guard against that by falling back to basename.
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        return rel;
      }
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder) {
      return uri.fsPath.slice(workspaceFolder.uri.fsPath.length + 1);
    }
    return path.basename(uri.fsPath);
  }
}
