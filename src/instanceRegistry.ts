import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * A directory of one JSON file per live VS Code window running this extension.
 *
 * It exists because a VS Code window is otherwise invisible to its siblings, and
 * two features need to know about them:
 *
 *  - plan routing compares this window's containment match against every other
 *    window's, so the deepest match wins deterministically with no timing race;
 *  - the Claude Code hook uses it to discover which ports to notify.
 *
 * One file per window rather than a single shared file, so concurrent windows
 * never race on a write.
 */

export const REGISTRY_DIR = path.join(os.homedir(), '.claude', 'claude-cli-companion', 'instances');

/** How often a live window refreshes `updatedAt`. */
const HEARTBEAT_MS = 60_000;
/** A record older than this is considered dead even if its pid still resolves. */
const STALE_MS = 5 * 60_000;

export interface InstanceRecord {
  instanceId: string;
  pid: number;
  /** Hook server port; absent until the server has bound. */
  port?: number;
  workspaceFolders: string[];
  updatedAt: number;
}

export class InstanceRegistry implements vscode.Disposable {
  /**
   * Random rather than pid-derived: VS Code does not guarantee one extension
   * host process per window, so a pid is not a unique window identity.
   */
  readonly instanceId = crypto.randomBytes(8).toString('hex');

  private port: number | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly log?: vscode.OutputChannel) {}

  /** Creates this window's record and starts keeping it fresh. */
  start(): void {
    this.pruneStale();
    this.write();
    this.heartbeat = setInterval(() => this.write(), HEARTBEAT_MS);
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.write()),
    );
  }

  /** Records the port the hook server bound to, so hooks can reach this window. */
  setPort(port: number): void {
    this.port = port;
    this.write();
  }

  /** Every live record, this window's included. */
  readAll(): InstanceRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(REGISTRY_DIR);
    } catch {
      return [];
    }
    const records: InstanceRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) { continue; }
      const record = readRecord(path.join(REGISTRY_DIR, name));
      if (record && isLive(record)) { records.push(record); }
    }
    return records;
  }

  /** Live records other than this window's. */
  readOthers(): InstanceRecord[] {
    return this.readAll().filter(r => r.instanceId !== this.instanceId);
  }

  /**
   * Removes records whose process is gone or whose heartbeat has lapsed. Covers
   * crashes, where `deactivate` never ran to clean up.
   */
  pruneStale(): void {
    let names: string[];
    try {
      names = fs.readdirSync(REGISTRY_DIR);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) { continue; }
      const file = path.join(REGISTRY_DIR, name);
      const record = readRecord(file);
      if (record && isLive(record)) { continue; }
      try {
        fs.unlinkSync(file);
        this.log?.appendLine(`[registry] pruned stale instance ${name}`);
      } catch { /* another window pruned it first */ }
    }
  }

  private get file(): string {
    return path.join(REGISTRY_DIR, `${this.instanceId}.json`);
  }

  private write(): void {
    const record: InstanceRecord = {
      instanceId: this.instanceId,
      pid: process.pid,
      port: this.port,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? [])
        .filter(f => f.uri.scheme === 'file')
        .map(f => f.uri.fsPath),
      updatedAt: Date.now(),
    };
    try {
      fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      this.log?.appendLine(`[registry] write failed: ${String(err)}`);
    }
  }

  dispose(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
    for (const d of this.disposables) { d.dispose(); }
    this.disposables.length = 0;
    try { fs.unlinkSync(this.file); } catch { /* already gone */ }
  }
}

function readRecord(file: string): InstanceRecord | undefined {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as InstanceRecord;
    return typeof record?.instanceId === 'string' ? record : undefined;
  } catch {
    return undefined;
  }
}

function isLive(record: InstanceRecord): boolean {
  if (Date.now() - (record.updatedAt ?? 0) > STALE_MS) { return false; }
  try {
    process.kill(record.pid, 0); // Signal 0 only tests for existence
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
