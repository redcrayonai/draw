import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { startLocal } from './local-server';
import { localDirectory } from './local-path';
import { localCall, localEndpoint } from './local-mcp';
export async function runLocal(args: string[]) {
  const open = args.includes('--open');
  args = args.filter(arg => arg !== '--open');
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--repo', '--store', '--port'].includes(args[i]) || !args[i + 1]) throw new Error('REJECTED: usage: redcrayon local [--repo path] [--store path] [--port number]');
    options.set(args[i], args[i + 1]);
  }
  const repo = realpathSync(options.get('--repo') ?? process.cwd());
  const directory = resolve(options.get('--store') ?? localDirectory(repo));
  const port = Number(options.get('--port') ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('REJECTED: invalid port');
  if (open && !options.has('--port')) {
    try {
      const endpoint = localEndpoint(['--repo', repo, '--store', directory]);
      await localCall(endpoint, { action: 'list_boards' }, AbortSignal.timeout(1000));
      const url = `${endpoint.origin}/#local&key=${endpoint.token}`;
      process.stderr.write(`Draw: ${url}\n`); openBrowser(url); return 0;
    } catch { /* A stale endpoint never permits bypassing the store's writer lock. */ }
  }
  const assets = join(dirname(fileURLToPath(import.meta.url)), 'local-assets');
  if (!existsSync(join(assets, 'local.html'))) throw new Error('UNAVAILABLE: local browser assets are missing. Run pnpm -C helper build:local or restore the packaged local-assets directory.');
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
