import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Pure helpers for reading Claude Code's on-disk transcript layout. Deliberately
 * free of any `vscode` import so the resolution logic can be exercised without an
 * extension host.
 *
 * Layout:
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl
 */

/** Directory where Claude Code writes per-project session transcripts. */
export const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

export interface PlanOwner {
  /** Absolute path of the `~/.claude/projects/<encoded>` directory. */
  projectDir: string;
  /** Absolute path of the transcript that claimed this plan. */
  transcriptPath: string;
  /**
   * Session root — the FIRST `cwd` in the transcript. `cwd` drifts mid-session
   * (a session rooted at `/repo` can end up reporting `/repo/frontend`), so only
   * the head value identifies where Claude was launched.
   */
  cwd: string;
  sessionId?: string;
  agentId?: string;
}

export interface TranscriptHead {
  slug?: string;
  cwd?: string;
  sessionId?: string;
  agentId?: string;
}

/**
 * Encodes an absolute path the way Claude Code names its project directories:
 * every non-alphanumeric character becomes `-`.
 *
 *   /Users/me/Projects/har_viewer  ->  -Users-me-Projects-har-viewer
 *   /repo/.claude/worktrees/wt     ->  -repo--claude-worktrees-wt
 *
 * The mapping is lossy (`.`, `_`, `/` all collapse to `-`), so it must only ever
 * be used in the encode direction — never decode a directory name back to a path.
 */
export function encodeProjectDirName(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Splits a plan file name into its slug and, for subagent plans, the agent id.
 * Subagent plans are named `<slug>-agent-<agentId>.md`.
 */
export function parsePlanBasename(planPath: string): { slug: string; agentId?: string } {
  const stem = path.basename(planPath).replace(/\.md$/i, '');
  const m = /^(.+)-agent-([0-9a-f]{8,})$/i.exec(stem);
  return m ? { slug: m[1], agentId: m[2] } : { slug: stem };
}

/**
 * Project directories that could belong to one of `encodedRoots`.
 *
 * Claude Code creates a project directory per *launch cwd*, not per repo root, so
 * a session started in a subfolder lands in `<encodedRoot>-<subpath>`. The prefix
 * test is a cheap candidate filter only: because the encoding is lossy,
 * `…-fixes-02` also prefix-matches `…-fixes-` without being its child. Callers
 * must confirm with a real path containment check against the resolved `cwd`.
 */
export function candidateProjectDirs(encodedRoots: string[]): string[] {
  if (encodedRoots.length === 0) { return []; }
  let entries: string[];
  try {
    entries = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return []; // No transcripts on this machine (or a remote host without them)
  }
  return entries
    .filter(e => encodedRoots.some(root => e === root || e.startsWith(root + '-')))
    .map(e => path.join(PROJECTS_DIR, e));
}

// Matches an unescaped `"key":"value"` — the negative lookbehind skips occurrences
// nested inside a JSON string (which appear as `\"key\":\"`), so a Bash tool_result
// that happens to quote a transcript cannot spoof these fields.
function firstField(text: string, key: string): string | undefined {
  const re = new RegExp(`(?<!\\\\)"${key}":"((?:[^"\\\\]|\\\\.)*)"`);
  const m = re.exec(text);
  if (!m) { return undefined; }
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return undefined;
  }
}

/**
 * Reads the first `bytes` of a transcript and extracts the identifying fields.
 *
 * Scans the raw head with regexes rather than parsing lines: a single transcript
 * line can exceed the read window (large tool results), which would leave a
 * line-based parser with nothing complete to work with. `slug` and `cwd` are
 * looked up independently because they do not share a line — the first
 * `cwd`-bearing line typically has no `slug`.
 */
export function readTranscriptHead(file: string, bytes = 64 * 1024): TranscriptHead | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    const text = buf.subarray(0, read).toString('utf8');
    return {
      slug: firstField(text, 'slug'),
      cwd: firstField(text, 'cwd'),
      sessionId: firstField(text, 'sessionId'),
      agentId: firstField(text, 'agentId'),
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** Newest-first `*.jsonl` files directly inside `dir`, filtered by mtime. */
function recentTranscripts(dir: string, maxAgeMs: number, limit: number): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const cutoff = Date.now() - maxAgeMs;
  const stamped: Array<{ file: string; mtime: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) { continue; }
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs >= cutoff) { stamped.push({ file, mtime: st.mtimeMs }); }
    } catch { /* vanished mid-scan */ }
  }
  return stamped.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map(s => s.file);
}

/**
 * Finds the transcript that produced `planPath`, searching only inside
 * `candidateDirs`.
 *
 * The query is deliberately inverted — a window asks "is this plan mine?" rather
 * than "who owns this plan?". Scanning the whole corpus would mean hundreds of
 * megabytes of I/O in every open window at once; scoping to this window's own
 * project directories means non-owning windows do zero content reads.
 *
 * Matching is on the `slug` field, never on the plan file name. Bash tool results
 * are recorded verbatim into transcripts, so any session that merely listed the
 * plans directory contains the file name and would match spuriously.
 */
export function resolvePlanOwnerIn(
  planPath: string,
  candidateDirs: string[],
  opts: { maxAgeMs?: number; headBytes?: number; maxFilesPerDir?: number } = {},
): PlanOwner | undefined {
  const { maxAgeMs = 24 * 60 * 60 * 1000, headBytes = 64 * 1024, maxFilesPerDir = 40 } = opts;
  const { slug, agentId } = parsePlanBasename(planPath);

  // Subagent plans resolve by pure path construction — a readdir per candidate,
  // no transcript content read at all.
  if (agentId) {
    for (const dir of candidateDirs) {
      let sessions: string[];
      try {
        sessions = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const session of sessions) {
        const file = path.join(dir, session, 'subagents', `agent-${agentId}.jsonl`);
        if (!fs.existsSync(file)) { continue; }
        const head = readTranscriptHead(file, headBytes);
        if (!head?.cwd) { continue; }
        return {
          projectDir: dir,
          transcriptPath: file,
          cwd: head.cwd,
          sessionId: head.sessionId ?? session,
          agentId,
        };
      }
    }
    return undefined;
  }

  for (const dir of candidateDirs) {
    for (const file of recentTranscripts(dir, maxAgeMs, maxFilesPerDir)) {
      const head = readTranscriptHead(file, headBytes);
      if (head?.slug !== slug || !head.cwd) { continue; }
      return {
        projectDir: dir,
        transcriptPath: file,
        cwd: head.cwd,
        sessionId: head.sessionId,
      };
    }
  }
  return undefined;
}
