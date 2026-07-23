import * as http from 'http';
import * as vscode from 'vscode';
import { DiffManager } from './diffManager';

export class HookServer {
  private server: http.Server | null = null;

  constructor(private readonly diffManager: DiffManager) {}

  start(port: number): void {
    this.server = http.createServer(async (req, res) => {
      console.log(`[claude-diff] ${req.method} ${req.url}`);
      if (req.url === '/health') { res.writeHead(200).end('ok'); return; }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        console.log(`[claude-diff] body length: ${body.length}`);
        try {
          const payload = JSON.parse(body);
          if (req.url === '/file-changed' && typeof payload.filePath === 'string') {
            console.log(`[claude-diff] file-changed: ${payload.filePath}`);
            await this.diffManager.onFileChanged(payload.filePath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            console.log(`[claude-diff] unhandled: url=${req.url}`);
            res.writeHead(404).end();
          }
        } catch (err) {
          console.log(`[claude-diff] error: ${err}`);
          res.writeHead(400).end(String(err));
        }
      });
    });

    this.server.listen(port, '127.0.0.1', () => {
      console.log(`[claude-diff] hook server listening on port ${port}`);
    });

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        vscode.window.showWarningMessage(
          `Claude Diff: Port ${port} already in use. Change it in settings (claudeDiff.port).`
        );
      }
    });
  }

  stop(): void { this.server?.close(); this.server = null; }
}
