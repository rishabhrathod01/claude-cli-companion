import * as vscode from 'vscode';

/**
 * Picks the editor group that plans and diffs should open in.
 *
 * Without this they open in the *active* group, and when Claude Code runs as an
 * editor-area terminal that group is the terminal's — so a plan or a diff lands
 * on top of the session that produced it instead of alongside the user's code.
 *
 * The rule is stateless on purpose: find the first group that already holds an
 * ordinary file, which is literally "where other files are open". Terminal tabs,
 * diff tabs, and preview tabs are not `TabInputText`, so a group containing only
 * those is skipped.
 *
 * @param isExcluded - Paths that should not count as an ordinary file. Callers
 *   pass `isPlanFile` so that an already-open plan does not nominate its own
 *   group as the target. Taking a predicate rather than importing `isPlanFile`
 *   keeps this module free of a cycle with `planManager`.
 * @returns The group to open in, or `undefined` when no group qualifies.
 */
export function targetViewColumn(
  isExcluded: (fsPath: string) => boolean,
): vscode.ViewColumn | undefined {
  // Guarded so a host without the tab API falls through to the `Beside`
  // default rather than throwing and never opening the plan at all.
  if (typeof vscode.TabInputText !== 'function') { return undefined; }

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (!(input instanceof vscode.TabInputText)) { continue; }
      if (input.uri.scheme !== 'file') { continue; }
      if (isExcluded(input.uri.fsPath)) { continue; }
      return group.viewColumn;
    }
  }
  return undefined;
}

/**
 * The group to open in, falling back to one beside the active group.
 *
 * `Beside` rather than `One` for the fallback: with no ordinary file open
 * anywhere, the only group is often the terminal's, and `One` would target it.
 */
export function targetViewColumnOrBeside(
  isExcluded: (fsPath: string) => boolean,
): vscode.ViewColumn {
  return targetViewColumn(isExcluded) ?? vscode.ViewColumn.Beside;
}
