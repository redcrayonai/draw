import { execFile, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { startLocal } from './local-server';
import { localDirectory } from './local-path';
import { localCall, localEndpoint } from './local-mcp';
import { localCommand } from './local-runtime';
export async function runLocal(args: string[]) {
  const open = args.includes('--open');
  const background = args.includes('--background');
  args = args.filter(arg => arg !== '--open' && arg !== '--background');
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--repo', '--store', '--port'].includes(args[i]) || !args[i + 1]) throw new Error('REJECTED: usage: draw local [--background] [--repo path] [--store path] [--port number]');
    options.set(args[i], args[i + 1]);
  }
  const repo = realpathSync(options.get('--repo') ?? process.cwd());
  const directory = resolve(options.get('--store') ?? localDirectory(repo));
  const port = Number(options.get('--port') ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('REJECTED: invalid port');
  if ((open || background) && !options.has('--port')) {
    try {
      const endpoint = localEndpoint(['--repo', repo, '--store', directory]);
      await localCall(endpoint, { action: 'list_boards' }, AbortSignal.timeout(1000));
      const url = `${endpoint.origin}/#local&key=${endpoint.token}`;
      process.stderr.write(`Draw: ${url}\n`); if (open) openBrowser(url); return 0;
    } catch { /* A stale endpoint never permits bypassing the store's writer lock. */ }
  }
  const assets = join(dirname(fileURLToPath(import.meta.url)), 'local-assets');
  if (!existsSync(join(assets, 'local.html'))) throw new Error('UNAVAILABLE: local browser assets are missing. Run pnpm -C helper build:local or restore the packaged local-assets directory.');
  if (background) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const log = join(directory, 'server.log'), fd = openSync(log, 'a', 0o600);
    const [command, ...prefix] = localCommand();
    let child: ReturnType<typeof spawn>;
    try {
      fchmodSync(fd, 0o600);
      child = spawn(command, [...prefix, 'local', '--repo', repo, '--store', directory, '--port', String(port)], { detached: true, stdio: ['ignore', fd, fd] });
    } finally { closeSync(fd); }
    let failure: Error | undefined, ready = false;
    child.once('error', () => { failure = new Error(`UNAVAILABLE: could not launch the local server; see ${log}`); });
    child.once('exit', () => { failure = new Error(`UNAVAILABLE: local server exited during startup; see ${log}`); });
    try {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        try {
          const endpoint = localEndpoint(['--repo', repo, '--store', directory]);
          if (endpoint.pid !== child.pid) throw new Error('Waiting for this server');
          await localCall(endpoint, { action: 'list_boards' }, AbortSignal.timeout(500));
          const url = `${endpoint.origin}/#local&key=${endpoint.token}`;
          ready = true; child.unref();
          process.stderr.write(`Storage: ${directory}\nServer PID: ${child.pid}\nLog: ${log}\nDraw: ${url}\n`);
          if (open) openBrowser(url);
          return 0;
        } catch { /* Wait for the child to publish a reachable endpoint. */ }
        await delay(100);
      }
      throw new Error(`UNAVAILABLE: local server startup timed out; see ${log}`);
    } finally { if (!ready) child.kill('SIGTERM'); }
  }
  const app = await startLocal({ repo, directory, port, assets });
  process.stderr.write(`Storage: ${directory}\nDraw: ${app.url}\n`);
  if (open) openBrowser(app.url);
  await new Promise<void>(resolve => {
    let closing = false;
    const close = () => { if (!closing) { closing = true; void app.close().then(resolve); } };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  });
  return 0;
}

function openBrowser(url: string) {
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], error => {
    if (error) process.stderr.write('UNAVAILABLE: could not open your browser; open the Draw URL above.\n');
  });
}
