import * as vscode from 'vscode';
import { execFileSync } from 'child_process';

/**
 * Locates the terminal running the Claude Code CLI.
 *
 * Name matching alone is not enough — `vscode.Terminal.name` is the shell name
 * (`zsh`) for terminals the user opened themselves, so someone who simply typed
 * `claude` in a normal terminal would never be found.
 *
 * Four signals, in descending order of confidence:
 *  1. the active terminal, when it qualifies — with two Claude terminals open,
 *     "first match" sends to the wrong one;
 *  2. shell-integration execution tracking, when the API exists;
 *  3. a `claude` descendant of the terminal's shell process;
 *  4. the name heuristic.
 */
export class ClaudeTerminalTracker implements vscode.Disposable {
  /** Terminals with a `claude` command currently executing. */
  private readonly running = new Set<vscode.Terminal>();
  /** Shell pids, resolved lazily because `Terminal.processId` is a promise. */
  private readonly shellPids = new WeakMap<vscode.Terminal, number>();
  /** Cached process probes, keyed by shell pid. */
  private readonly probed = new Map<number, { result: boolean; at: number }>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly log?: vscode.OutputChannel) {
    const w = vscode.window as any;
    // Feature-detected: shell execution events need VS Code 1.93+, and the
    // extension still targets 1.85.
    if (typeof w.onDidStartTerminalShellExecution === 'function') {
      this.disposables.push(
        w.onDidStartTerminalShellExecution((e: any) => {
          if (isClaudeCommand(e?.execution?.commandLine?.value)) { this.running.add(e.terminal); }
        }),
        w.onDidEndTerminalShellExecution((e: any) => {
          if (isClaudeCommand(e?.execution?.commandLine?.value)) { this.running.delete(e.terminal); }
        }),
      );
    }
    this.disposables.push(
      vscode.window.onDidCloseTerminal(t => this.running.delete(t)),
    );
  }

  /** The best Claude terminal in this window, or `undefined`. */
  find(): vscode.Terminal | undefined {
    const active = vscode.window.activeTerminal;
    if (active && this.qualifies(active)) { return active; }
    return vscode.window.terminals.find(t => this.qualifies(t));
  }

  hasAny(): boolean {
    return this.find() !== undefined;
  }

  private qualifies(terminal: vscode.Terminal): boolean {
    if (this.running.has(terminal)) { return true; }
    if (terminal.name.toLowerCase().includes('claude')) { return true; }
    return this.hasClaudeDescendant(terminal);
  }

  /**
   * Looks for a `claude` child of the terminal's shell. Catches terminals that
   * predate activation and shells without integration; POSIX only.
   *
   * Matches on the full command line (`-f`), not the process name: an
   * npm-installed CLI runs as `node …/claude/cli.js`, so the process name alone
   * is just `node`. Only direct children are examined — a `claude` buried under a
   * wrapper script is missed, which is acceptable for a last-resort signal.
   */
  private hasClaudeDescendant(terminal: vscode.Terminal): boolean {
    if (process.platform === 'win32') { return false; }

    // `processId` is a promise but `find()` is synchronous, so the first probe of
    // a terminal only kicks off the lookup; later calls use the cached pid.
    const pid = this.shellPids.get(terminal);
    if (pid === undefined) {
      void terminal.processId.then(resolved => {
        if (resolved !== undefined) { this.shellPids.set(terminal, resolved); }
      });
      return false;
    }

    const cached = this.probed.get(pid);
    if (cached && Date.now() - cached.at < 2_000) { return cached.result; }

    let result = false;
    try {
      const out = execFileSync('pgrep', ['-P', String(pid), '-fl'], { encoding: 'utf8' });
      result = out.split('\n').some(isClaudeCommand);
    } catch {
      result = false; // pgrep exits non-zero when there are no children
    }
    this.probed.set(pid, { result, at: Date.now() });
    return result;
  }

  dispose(): void {
    for (const d of this.disposables) { d.dispose(); }
    this.disposables.length = 0;
    this.running.clear();
    this.probed.clear();
  }
}

/**
 * True when a command line invokes the Claude CLI.
 *
 * `claude` must appear as a whole path component so that `cd ~/claude-code-context`
 * and `vim claude.md` do not register, while `claude --resume`,
 * `/…/MacOS/claude`, and `node …/claude/cli.js` all do.
 */
function isClaudeCommand(commandLine: unknown): boolean {
  return typeof commandLine === 'string' && /(^|[/\s])claude([\s/]|$)/i.test(commandLine.trim());
}
