// Bun is a build tool only: the resulting draw executable contains its runtime and assets.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bun = process.versions.bun ? process.execPath : 'bun';
const bunVersion = execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim();
if (bunVersion !== '1.4.4') throw new Error('Use Bun 1.4.4 to build the verified standalone runtime.');
if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Standalone builds currently support macOS and Linux.');
execFileSync('pnpm', ['build:local'], { cwd: here, stdio: 'inherit' });
const dist = join(here, 'dist'), output = join(dist, 'binary');
mkdirSync(output, { recursive: true });
const version = JSON.parse(readFileSync(join(dist, 'plugin.json'), 'utf8')).version;
const entry = join(output, 'entry.mjs');
writeFileSync(entry, `
const args = process.argv.slice(2);
if (args[0] === '--version' || args[0] === '-v') console.log('draw ${version} (Bun ${bunVersion})');
else if (args[0] === '--help' || args[0] === '-h') console.log(
  'Draw — local architecture boards\\n\\n' +
  '  draw [--repo path] [--port number] [--no-open]   Open the board\\n' +
  '  draw install codex                             Install the Codex integration\\n' +
  '  draw local-mcp --per-repo                       Run the local MCP bridge\\n' +
  '  draw live --board slug --map mapping.json       Animate piped activity\\n\\n' +
  'Boards are saved locally. Keep this executable in place after installing the integration.'
);
else {
  if (!args.length || args[0].startsWith('--')) {
    process.argv.splice(2, process.argv.length - 2, 'local', ...(args.includes('--no-open') ? [] : ['--open']), ...args.filter(arg => arg !== '--no-open'));
  }
  await import('../redcrayon.mjs');
}
`);
const assets = ['local-assets', 'skills', 'mcp.json', 'plugin.json', '.codex-plugin', '.claude-plugin'];
execFileSync(bun, ['build', entry, '--compile', '--format=esm', '--bytecode', '--minify', ...assets.flatMap(path => ['--asset', path]), '--outfile', join(output, 'draw')], { cwd: dist, stdio: 'inherit' });
chmodSync(join(output, 'draw'), 0o755);
const pack = join(output, 'package');
rmSync(pack, { recursive: true, force: true });
mkdirSync(join(pack, 'licenses'), { recursive: true });
copyFileSync(join(output, 'draw'), join(pack, 'draw'));
copyFileSync(join(dist, 'local-pi-extension.mjs'), join(pack, 'local-pi-extension.mjs'));
copyFileSync(join(here, '../LICENSE'), join(pack, 'LICENSE'));
for (const [source, name] of [
  ['licenses/Bun.md', 'Bun.md'],
  ['node_modules/ws/LICENSE', 'ws.txt'],
  ['../client/public/assets/fonts/OFL-Geist.txt', 'Geist.txt'],
  ['../client/public/assets/fonts/OFL-Geist-Mono.txt', 'Geist-Mono.txt'],
]) copyFileSync(join(here, source), join(pack, 'licenses', name));
writeFileSync(join(pack, 'package.json'), JSON.stringify({
  name: '@redcrayonai/draw-local', version, description: 'Standalone local Draw architecture boards',
  license: 'Apache-2.0', bin: { draw: 'draw' }, os: [process.platform], cpu: [process.arch],
}, null, 2) + '\n');
const archive = `draw-${process.platform}-${process.arch}.tgz`;
execFileSync('tar', ['-czf', join(output, archive), '-C', output, 'package']);
writeFileSync(join(output, 'SHA256SUMS'), `${createHash('sha256').update(readFileSync(join(output, archive))).digest('hex')}  ${archive}\n`);
process.stderr.write(`Executable: ${join(output, 'draw')}\nInstall with: bun install -g ${join(output, archive)}\n`);
