import * as vscode from 'vscode';
import {
  PlanOwner,
  candidateProjectDirs,
  encodeProjectDirName,
  resolvePlanOwnerIn,
} from './claudeProjects';
import { InstanceRecord, InstanceRegistry } from './instanceRegistry';
import { bestMatch } from './paths';
import { PlanManager } from './planManager';

export type PlanAutoOpen = 'owner' | 'always' | 'never';

export type Verdict =
  /** This window owns the session that wrote the plan and should render it. */
  | { kind: 'owned'; owner: PlanOwner; folder: string; specificity: number }
  /** Resolved to a session that belongs to a different window. */
  | { kind: 'foreign'; reason: string; owner?: PlanOwner }
  /** No transcript in this window's project directories claims the plan. */
  | { kind: 'unresolved' };

export interface OwnershipContext {
  instanceId: string;
  folders: string[];
  others: InstanceRecord[];
}

/**
 * Decides whether this window should render a plan.
 *
 * Containment alone is not enough to pick a single window: a git worktree at
 * `/repo/.claude/worktrees/wt` is contained by both a window opened on the
 * worktree and one opened on `/repo`. The deepest containing folder wins, and
 * because every window can read every other window's folders from the instance
 * registry, each one reaches the same verdict independently — no shared claim
 * file and no timing race.
 */
export function judge(owner: PlanOwner | undefined, ctx: OwnershipContext): Verdict {
  if (!owner) { return { kind: 'unresolved' }; }

  const mine = bestMatch(ctx.folders, owner.cwd);
  if (!mine) {
    return { kind: 'foreign', reason: 'cwd is outside this window\'s folders', owner };
  }

  for (const other of ctx.others) {
    const theirs = bestMatch(other.workspaceFolders ?? [], owner.cwd);
    if (!theirs) { continue; }
    if (theirs.specificity > mine.specificity) {
      return { kind: 'foreign', reason: `window ${other.instanceId} matches more deeply`, owner };
    }
    // Identical folder open in two windows: settle it on instance id so both
    // windows agree on the same winner.
    if (theirs.specificity === mine.specificity && other.instanceId < ctx.instanceId) {
      return { kind: 'foreign', reason: `window ${other.instanceId} wins the tiebreak`, owner };
    }
  }

  return { kind: 'owned', owner, folder: mine.parent, specificity: mine.specificity };
}

/**
 * Resolves a plan's owner, retrying briefly.
 *
 * The retry is belt-and-braces rather than a real poll: the transcript line
 * carrying the slug is written at session start, typically minutes before the
 * plan file appears, so the answer is normally on disk already.
 */
export async function resolveWithRetry(
  planPath: string,
  ctx: OwnershipContext,
  attempts = 2,
  intervalMs = 250,
): Promise<Verdict> {
  const encodedRoots = ctx.folders.map(encodeProjectDirName);

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) { await delay(intervalMs); }
    const candidates = candidateProjectDirs(encodedRoots);
    // No project directory corresponds to any of this window's folders, so the
    // plan cannot be ours. Costs one readdir and zero content reads.
    if (candidates.length === 0) { continue; }
    const owner = resolvePlanOwnerIn(planPath, candidates);
    if (owner) { return judge(owner, ctx); }
  }
  return { kind: 'unresolved' };
}

/**
 * Single funnel for every plan-render trigger. Decides ownership, then renders.
 */
export class PlanRouter {
  /**
   * Plans this window has already evaluated. Collapses the create/change burst
   * from the file watcher, and preserves the existing behaviour that a plan
   * Claude edits later does not re-open and steal the editor.
   */
  private readonly seen = new Set<string>();

  constructor(
    private readonly deps: {
      planManager: PlanManager;
      registry: InstanceRegistry;
      getMode: () => PlanAutoOpen;
      log: vscode.OutputChannel;
    },
  ) {}

  /**
   * @param planPath - Absolute path of the plan markdown file.
   * @param cwdHint - Session root supplied by a Claude Code hook, when one fired.
   *   Skips the transcript scan entirely.
   */
  async handle(planPath: string, cwdHint?: string): Promise<void> {
    if (this.seen.has(planPath)) { return; }
    this.seen.add(planPath);

    const mode = this.deps.getMode();
    if (mode === 'never') { return; }
    if (mode === 'always') {
      this.deps.log.appendLine(`[plan] ${planPath}: autoOpen=always, rendering`);
      await this.deps.planManager.render(planPath);
      return;
    }

    let verdict: Verdict;
    try {
      const ctx = this.context();
      verdict = cwdHint
        // A hook fired, so the session root is already known — no transcript scan.
        ? judge({ projectDir: '', transcriptPath: '', cwd: cwdHint }, ctx)
        : await resolveWithRetry(planPath, ctx);
    } catch (err) {
      this.deps.log.appendLine(`[plan] ${planPath}: resolve failed — ${String(err)}`);
      return;
    }

    this.deps.log.appendLine(`[plan] ${planPath}: ${describe(verdict)}`);
    if (verdict.kind !== 'owned') { return; }

    await this.deps.planManager.render(planPath);
  }

  /** Renders a plan on explicit user request, bypassing ownership entirely. */
  async renderExplicitly(planPath: string): Promise<void> {
    this.seen.add(planPath);
    await this.deps.planManager.render(planPath);
  }

  private context(): OwnershipContext {
    return {
      instanceId: this.deps.registry.instanceId,
      folders: (vscode.workspace.workspaceFolders ?? [])
        .filter(f => f.uri.scheme === 'file')
        .map(f => f.uri.fsPath),
      others: this.deps.registry.readOthers(),
    };
  }
}

function describe(verdict: Verdict): string {
  switch (verdict.kind) {
    case 'owned':      return `owned (cwd=${verdict.owner.cwd}, folder=${verdict.folder})`;
    case 'foreign':    return `foreign — ${verdict.reason}`;
    case 'unresolved': return 'unresolved — no matching transcript in this window\'s projects';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
