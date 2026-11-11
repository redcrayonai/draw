import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { startLocal } from './local-server';

export function localDirectory(repo: string) {
  return join(homedir(), '.redcrayon', 'local', createHash('sha256').update(realpathSync(repo)).digest('hex').slice(0, 24));
}
export async function runLocal(args: string[]) {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--repo', '--store', '--port'].includes(args[i]) || !args[i + 1]) throw new Error('REJECTED: usage: redcrayon local [--repo path] [--store path] [--port number]');
    options.set(args[i], args[i + 1]);
  }
  const repo = realpathSync(options.get('--repo') ?? process.cwd());
  const directory = resolve(options.get('--store') ?? localDirectory(repo));
  const port = Number(options.get('--port') ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('REJECTED: invalid port');
  const assets = join(dirname(fileURLToPath(import.meta.url)), 'local-assets');
  if (!existsSync(join(assets, 'local.html'))) throw new Error('UNAVAILABLE: local browser assets are missing. Run pnpm -C helper build:local or restore the packaged local-assets directory.');
  const app = await startLocal({ repo, directory, port, assets });
  process.stderr.write(`Storage: ${directory}\nDraw: ${app.url}\n`);
  await new Promise<void>(resolve => {
    let closing = false;
    const close = () => { if (!closing) { closing = true; void app.close().then(resolve); } };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  });
  return 0;
}
