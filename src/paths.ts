import * as path from 'path';

/** True on platforms whose filesystems are conventionally case-insensitive. */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

function normalize(p: string): string {
  const resolved = path.resolve(p);
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

/**
 * True when `child` is `parent` or lives inside it.
 *
 * Uses `path.relative` rather than a string prefix test: `'/a/foo-bar'.startsWith('/a/foo')`
 * is true even though `foo-bar` is not inside `foo`.
 */
export function contains(parent: string, child: string): boolean {
  const rel = path.relative(normalize(parent), normalize(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Specificity of a containment match: the length of the containing path. Deeper
 * folders win, which is what resolves nested cases such as a git worktree living
 * under its own repo root.
 */
export function specificityOf(parent: string): number {
  return normalize(parent).length;
}

/**
 * Best (deepest) containment match of `child` among `parents`, or `undefined`
 * when none contains it.
 */
export function bestMatch(parents: readonly string[], child: string):
  { parent: string; specificity: number } | undefined {
  let best: { parent: string; specificity: number } | undefined;
  for (const parent of parents) {
    if (!contains(parent, child)) { continue; }
    const specificity = specificityOf(parent);
    if (!best || specificity > best.specificity) { best = { parent, specificity }; }
  }
  return best;
}
