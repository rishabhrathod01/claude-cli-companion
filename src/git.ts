import * as path from 'path';
import { ExecFileSyncOptionsWithStringEncoding, execFileSync } from 'child_process';

/**
 * Contents of `filePath` as of `HEAD`, or `undefined` when the file is not in
 * `HEAD` (untracked, newly created, or outside a repository).
 *
 * The distinction matters: a file absent from `HEAD` and a file that is empty in
 * `HEAD` both used to read as `''`, which would let the commit reconciler mistake
 * a brand-new empty file for a committed one.
 */
export function getGitHeadContent(filePath: string): string | undefined {
  // Untracked files and non-repo paths are expected, not exceptional, so git's
  // stderr is discarded rather than left to spill into the extension host log.
  const quiet: ExecFileSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  };
  try {
    // execFileSync with an argument array — no shell interpolation of filePath
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: path.dirname(filePath), ...quiet,
    }).trim();
    const relative = path.relative(gitRoot, filePath);
    return execFileSync('git', ['show', `HEAD:${relative}`], {
      cwd: gitRoot, ...quiet,
    });
  } catch {
    return undefined;
  }
}
