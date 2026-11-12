import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { standalone } from './local-runtime';

const files = ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/marketplace.json', 'mcp.json', 'skills/local/SKILL.md'];

/** Only integration files are extracted; the executable serves its embedded UI directly. */
export function prepareLocalPlugin(source: string, destination: string, executable: string) {
  const contents = new Map(files.map(file => [file, readFileSync(join(source, file), 'utf8')]));
  const id = createHash('sha256').update(JSON.stringify([...contents])).update(executable).digest('hex').slice(0, 16);
  const target = join(destination, id);
  if (existsSync(target)) return target;
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(destination, '.install-'));
  try {
    for (const [file, raw] of contents) {
      let text = raw;
      if (file === 'mcp.json') {
        const config = JSON.parse(raw);
        config.mcpServers['draw-local'] = { type: 'stdio', command: executable, args: ['local-mcp', '--per-repo'] };
        text = JSON.stringify(config, null, 2);
      }
      if (file === 'plugin.json' || file === '.codex-plugin/plugin.json') {
        const config = JSON.parse(raw); config.version = config.version.split('+')[0] + `+binary.${id}`;
        text = JSON.stringify(config, null, 2);
      }
      mkdirSync(dirname(join(temporary, file)), { recursive: true, mode: 0o700 });
      writeFileSync(join(temporary, file), text + '\n', { mode: 0o600 });
    }
    try { renameSync(temporary, target); }
    catch (error) { if (!existsSync(target)) throw error; }
    return target;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function runLocalInstall(args: string[]) {
  if (args.length !== 1 || args[0] !== 'codex') throw new Error('REJECTED: usage: draw install codex');
  const source = dirname(fileURLToPath(import.meta.url));
  if (!existsSync(join(source, 'mcp.json'))) throw new Error('UNAVAILABLE: local plugin files are missing; use the local distribution');
  const plugin = standalone ? prepareLocalPlugin(source, join(homedir(), '.redcrayon', 'plugins'), process.execPath) : source;
  installLocalCodex(plugin);
  process.stderr.write('Draw installed for Codex. Start Codex in your repository and ask: Use $draw-local:local to open a board.\n');
  return 0;
}

export function installLocalCodex(plugin: string, marketplace = 'draw-local-dev', name = 'draw-local') {
  const { marketplaces } = JSON.parse(execFileSync('codex', ['plugin', 'marketplace', 'list', '--json'], { encoding: 'utf8' }));
  const existing = marketplaces.find((market: { name: string }) => market.name === marketplace);
  const replacing = existing?.root !== plugin;
  if (replacing && existing && existing.marketplaceSource?.sourceType !== 'local') throw new Error(`REJECTED: ${marketplace} is not a local marketplace`);
  let changed = false, registered = false;
  try {
    if (replacing) {
      if (existing) { execFileSync('codex', ['plugin', 'marketplace', 'remove', marketplace], { stdio: 'inherit' }); changed = true; }
      execFileSync('codex', ['plugin', 'marketplace', 'add', plugin], { stdio: 'inherit' }); changed = registered = true;
    }
    execFileSync('codex', ['plugin', 'add', `${name}@${marketplace}`], { stdio: 'inherit' });
  } catch (error) {
    if (changed) {
      if (registered) execFileSync('codex', ['plugin', 'marketplace', 'remove', marketplace], { stdio: 'inherit' });
      if (existing) execFileSync('codex', ['plugin', 'marketplace', 'add', existing.root], { stdio: 'inherit' });
    }
    throw error;
  }
}
