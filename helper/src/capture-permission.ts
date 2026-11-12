import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { runtimePermissions, PermissionError, enforceToolPermissions } from './permissions';
import { origin, type CaptureOpts } from './capture';
import type { CaptureKind } from '../../shared/capture';

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const openBrowser = (url: string) => { execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], error => {
  if (error) process.stderr.write('Open the Draw approval link above in your browser.\n');
}); };

/** A one-use local form approves this in-memory request, never a reusable file or agent-supplied grant. */
export async function requestCaptureApproval(message: string, open = openBrowser, timeoutMs = 60_000, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  const path = `/${randomBytes(32).toString('hex')}`;
  let origin = '', settle!: (allowed: boolean) => void;
  const decision = new Promise<boolean>(resolve => { settle = resolve; });
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    response.setHeader('Connection', 'close');
    if (`http://${request.headers.host}` !== origin || request.url !== path || request.headers['sec-fetch-site'] === 'cross-site' || (request.headers.origin && request.headers.origin !== origin)) {
      response.writeHead(403).end(); return;
    }
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Draw source permission</title><style>body{font:18px system-ui;max-width:44rem;margin:4rem auto;padding:1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{font:inherit;padding:.6rem 1rem;margin-right:1rem}</style><h1>Read and upload source code?</h1><pre>${escape(message)}</pre><p>This approval applies once to this capture. It does not change your saved Ask/Deny settings.</p><form method="post"><button name="decision" value="deny">Deny</button><button name="decision" value="allow">Allow once</button></form></html>`);
      return;
    }
    if (request.method !== 'POST' || request.headers.origin !== origin) { response.writeHead(403).end(); return; }
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 128) { response.writeHead(413).end(); return; }
      }
      if (!['decision=allow', 'decision=deny'].includes(body)) { response.writeHead(400).end(); return; }
      const allowed = body === 'decision=allow';
      response.end(allowed ? 'Approved once. You can close this tab.' : 'Denied. Nothing will be uploaded.', () => settle(allowed));
    } catch { settle(false); }
  });
  server.requestTimeout = 5000; server.maxConnections = 8;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => settle(false);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    if (signal?.aborted) return false;
    const address = server.address();
    if (!address || typeof address === 'string') return false;
    origin = `http://127.0.0.1:${address.port}`;
    timer = setTimeout(() => settle(false), timeoutMs);
    process.stderr.write(`Draw needs your approval before reading or uploading source: ${origin}${path}\n`);
    open(origin + path);
    return await decision;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    server.closeAllConnections(); server.close();
  }
}

export async function requireCapturePermission(kind: CaptureKind, opts: CaptureOpts, signal?: AbortSignal) {
  enforceToolPermissions('capture', 'hosted');
  const permissions = runtimePermissions('hosted');
  // Session metadata contains no source bytes. File captures need separate, pre-read consent.
  if (!permissions || kind === 'start') return;
  const denied = () => {
    const current = runtimePermissions('hosted');
    if (!current || current.boards === 'deny' || current.snippets === 'deny' || current.uploads === 'deny') {
      throw new PermissionError('REJECTED: Draw source capture is denied. No source was read or uploaded. Review draw permissions codex --mode hosted.');
    }
  };
  denied();
  const message = `Repository: ${opts.cwd}\nDestination: ${origin()}\nCapture: ${kind}\n${opts.path ? `File: ${opts.path}\n` : `Board: ${opts.board ?? ''}\nFiles: the board's cited files${opts.also?.length ? ` and ${opts.also.join(', ')}` : ''}\n`}Draw reads and sends entire files, including uncited lines. Hosted Draw temporarily receives those files; saved snippets follow the board's code-storage settings.\nApprove only in this browser window; the agent must not submit this form.`;
  if (!await requestCaptureApproval(message, openBrowser, 60_000, signal)) throw new PermissionError('UNCONFIRMED: source capture was not approved. No source was read or uploaded.');
  denied(); // A denial saved while the form was open wins over the one-time approval.
}
