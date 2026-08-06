import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { targetViewColumnOrBeside } from './editorGroups';

/** Directory where Claude Code writes plan-mode markdown files. */
export const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans');

/**
 * True when `fsPath` is a markdown file inside the Claude plans directory.
 * These are the plan-mode files Claude Code writes during planning; the
 * extension renders them and lets the user send selections back to the CLI.
 */
export function isPlanFile(fsPath: string): boolean {
  return fsPath.startsWith(PLANS_DIR + path.sep) && fsPath.endsWith('.md');
}

export class PlanManager {
  constructor(
    private readonly findClaudeTerminal: () => vscode.Terminal | undefined,
    private readonly sendRefToTerminal: (t: vscode.Terminal, ref: string) => void,
  ) {}

  /**
   * Opens a plan file as a source editor with the native markdown preview to
   * the side. Focus is preserved so rendering a plan mid-stream does not steal
   * the keyboard from the terminal where Claude is still working.
   *
   * Targets the group that already holds ordinary files rather than the active
   * one — when Claude Code runs as an editor-area terminal, the active group is
   * the terminal's, and the plan would open on top of the session that wrote it.
   *
   * @param filePath - Absolute path of the plan markdown file.
   */
  async render(filePath: string): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    await vscode.window.showTextDocument(uri, {
      viewColumn: targetViewColumnOrBeside(isPlanFile),
      preview: false,
      preserveFocus: true,
    });
    await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
  }

  /**
   * Sends the active plan file as a full-file `@file:1-N` reference to the
   * Claude terminal so Claude reads the whole plan, then closes the editor and
   * preview tabs. The file itself is left on disk — it is Claude's own
   * plan-mode artifact, not something this extension owns.
   *
   * No-ops with a warning if no plan file is active or no Claude terminal is open.
   */
  async buildActivePlan(): Promise<void> {
    const filePath = this.getActivePlanPath();
    if (!filePath) {
      vscode.window.showWarningMessage('No plan file is currently active in the editor.');
      return;
    }

    const terminal = this.findClaudeTerminal();
    if (!terminal) {
      vscode.window.showWarningMessage(
        'No Claude terminal found. Use Cmd+Shift+L to open one first.',
      );
      return; // Preserve state — user can retry once Claude is open
    }

    const lineCount = fs.readFileSync(filePath, 'utf8').split('\n').length;
    this.sendRefToTerminal(terminal, `@${filePath}:1-${lineCount}`);
    await this.closeTabs(filePath);
  }

  /**
   * Discards the active plan from the editor without sending it to Claude.
   * Closes the editor and preview tabs; the file is left on disk.
   */
  async discardActivePlan(): Promise<void> {
    const filePath = this.getActivePlanPath();
    if (!filePath) {
      vscode.window.showWarningMessage('No plan file is currently active in the editor.');
      return;
    }
    await this.closeTabs(filePath);
  }

  /**
   * Returns the absolute path of the plan file open in the active editor, or
   * `undefined` if the active editor is not a plan file.
   */
  private getActivePlanPath(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === 'file' && isPlanFile(uri.fsPath)) {
      return uri.fsPath;
    }
    return undefined;
  }

  /**
   * Closes all editor and preview tabs associated with `filePath`.
   *
   * @param filePath - Absolute path of the plan file whose tabs to close.
   */
  private async closeTabs(filePath: string): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as any;
        const tabUri: vscode.Uri | undefined = input?.uri ?? input?.modified;
        if (tabUri?.fsPath === filePath) {
          await vscode.window.tabGroups.close(tab, true);
        }
      }
    }
  }
}
