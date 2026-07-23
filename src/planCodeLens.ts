import * as vscode from 'vscode';
import { isPlanFile } from './planManager';

/**
 * Renders clickable "Build Plan" / "Discard" actions at the top of a Claude
 * plan file. The CTA lives inside the plan source itself, in the same editor
 * where selecting lines and pressing Cmd+L works.
 */
export class PlanCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isPlanFile(document.uri.fsPath)) {
      return [];
    }

    const range = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(range, {
        title: '$(run-all) Build Plan',
        command: 'claudePlan.build',
        tooltip: 'Send the full plan to Claude, then close these tabs',
      }),
      new vscode.CodeLens(range, {
        title: '$(close) Discard',
        command: 'claudePlan.discard',
        tooltip: 'Close the plan tabs without sending it',
      }),
    ];
  }
}
