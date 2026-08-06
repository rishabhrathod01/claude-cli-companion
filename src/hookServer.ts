import * as http from 'http';
import * as vscode from 'vscode';
import { DiffManager } from './diffManager';
import { isPlanFile } from './planManager';
import { bestMatch } from './paths';

/** Payload sent by the Claude Code hook. `cwd` is absent on pre-v2 hook entries. */
interface FileChangedPayload {
  filePath?: string;
  cwd?: string;
  transcriptPath?: string;
}

export class HookServer implements vscode.Disposable {
  private server: http.Server | null = null;
  private boundPort: number | undefined;

  constructor(
    private readonly diffManager: DiffManager,
    private readonly onPlanWritten: (planPath: string, cwd?: string) => void,
    private readonly log: vscode.OutputChannel,
  ) {}

  /**
   * Binds `preferredPort`, falling back to an ephemeral port when it is taken.
   *
   * Every window runs a server now, so a collision is the normal case rather than
   * a misconfiguration — the hook reaches each window through the instance
   * registry, not through a well-known port.
   *
   * @returns The port actually bound, or `undefined` if binding failed outright.
   */
  async start(preferredPort: number): Promise<number | undefined> {
    this.server = http.createServer((req, res) => this.handle(req, res));

    // Once bound, keep a handler attached: an unhandled 'error' on an http.Server
    // takes down the extension host.
    const keepAlive = (port: number) => {
      this.server?.on('error', err => this.log.appendLine(`[hook] server error: ${String(err)}`));
      return (this.boundPort = port);
    };

    const bound = await this.listen(preferredPort);
    if (bound !== undefined) { return keepAlive(bound); }

    const fallback = await this.listen(0);
    if (fallback !== undefined) {
      this.log.appendLine(`[hook] port ${preferredPort} busy — bound ephemeral port ${fallback}`);
      return keepAlive(fallback);
    }

    this.log.appendLine('[hook] could not bind any port — diff review is disabled in this window');
    return undefined;
  }

  private listen(port: number): Promise<number | undefined> {
    return new Promise(resolve => {
      const server = this.server;
      if (!server) { resolve(undefined); return; }

      const onError = () => { server.removeListener('listening', onListening); resolve(undefined); };
      const onListening = () => {
        server.removeListener('error', onError);
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : undefined);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === '/health') { res.writeHead(200).end('ok'); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      void (async () => {
        try {
          const payload = JSON.parse(body) as FileChangedPayload;
          if (req.url !== '/file-changed' || typeof payload.filePath !== 'string') {
            res.writeHead(404).end();
            return;
          }
          const acted = await this.onFileChanged(payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, acted }));
        } catch (err) {
          this.log.appendLine(`[hook] error: ${String(err)}`);
          res.writeHead(400).end(String(err));
        }
      })();
    });
  }

  /**
   * The hook broadcasts to every registered window; each one decides locally
   * whether the change is its own. That keeps the routing rule in one place
   * instead of encoding it in a shell command.
   */
  private async onFileChanged(payload: FileChangedPayload): Promise<boolean> {
    const filePath = payload.filePath as string;

    // Plan files live outside any workspace, so containment cannot judge them.
    // Forward unfiltered and let the plan router decide — it is the one place
    // that applies the deepest-match tiebreak across windows.
    if (isPlanFile(filePath)) {
      this.onPlanWritten(filePath, payload.cwd);
      return true;
    }

    // `filePath` containment is the primary test for edits inside a repo, and it
    // keeps working for hook entries installed before `cwd` was sent.
    if (!this.owns(filePath) && !(payload.cwd && this.owns(payload.cwd))) {
      this.log.appendLine(`[hook] ignoring ${filePath} (cwd=${payload.cwd ?? 'n/a'}) — not this window`);
      return false;
    }

    await this.diffManager.onFileChanged(filePath);
    return true;
  }

  private owns(target: string): boolean {
    const folders = (vscode.workspace.workspaceFolders ?? [])
      .filter(f => f.uri.scheme === 'file')
      .map(f => f.uri.fsPath);
    return bestMatch(folders, target) !== undefined;
  }

  get port(): number | undefined { return this.boundPort; }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.boundPort = undefined;
  }

  dispose(): void { this.stop(); }
}
