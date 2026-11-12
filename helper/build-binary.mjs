// Bun is a build tool only: the executable contains its runtime, UI, and agent integrations.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bun = process.env.BUN_BINARY ?? (process.versions.bun ? process.execPath : 'bun');
const bunVersion = execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim();
if (bunVersion !== '1.4.4') throw new Error('Use Bun 1.4.4 to build the verified standalone runtime.');
if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) throw new Error('Standalone builds support macOS and Linux on arm64 and x64.');
const plugin = join(here, '../plugin');
const manifest = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8'));
const { version } = manifest;
if (JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version !== version) throw new Error('Helper and npm package versions must agree.');
for (const pinned of Object.values(manifest.optionalDependencies)) {
  if (pinned !== version) throw new Error('Native optional dependencies must match the npm package version.');
}
execFileSync('pnpm', ['build:local'], { cwd: here, stdio: 'inherit' });
const dist = join(here, 'dist'), output = join(dist, 'binary');
mkdirSync(output, { recursive: true });
rmSync(join(dist, 'unified'), { recursive: true, force: true });
cpSync(join(plugin, 'unified'), join(dist, 'unified'), { recursive: true });
// Keep the hosted plugin's historical Node entry points for existing plugin installations.
for (const name of ['redcrayon.mjs', 'chat-hook.mjs']) copyFileSync(join(dist, name), join(plugin, 'bin', name));
mkdirSync(join(plugin, 'pi'), { recursive: true });
copyFileSync(join(dist, 'pi-extension.mjs'), join(plugin, 'pi/extension.mjs'));
const hosted = join(dist, 'hosted-plugin');
rmSync(hosted, { recursive: true, force: true });
mkdirSync(hosted, { recursive: true });
for (const name of [...manifest.files, 'package.json']) {
  cpSync(join(plugin, name), join(hosted, name), { recursive: true });
}
const assets = ['local-assets', 'skills', 'unified', 'mcp.json', 'plugin.json', '.codex-plugin', '.claude-plugin', 'local-pi-extension.mjs', 'pi-extension.mjs', 'hosted-plugin'];
const target = `bun-${process.platform}-${process.arch}${process.arch === 'x64' ? '-baseline' : ''}`;
execFileSync(bun, ['build', join(here, 'src/binary-cli.ts'), '--compile', `--target=${target}`, '--format=esm', '--bytecode', '--minify', '--define', `__DRAW_VERSION__=${JSON.stringify(version)}`, ...assets.flatMap(path => ['--asset', path]), '--outfile', join(output, 'draw')], { cwd: dist, stdio: 'inherit' });
chmodSync(join(output, 'draw'), 0o755);
const pack = join(output, 'package');
rmSync(pack, { recursive: true, force: true });
mkdirSync(join(pack, 'licenses'), { recursive: true });
copyFileSync(join(output, 'draw'), join(pack, 'draw'));
copyFileSync(join(here, '../LICENSE'), join(pack, 'LICENSE'));
for (const [source, name] of [
  ['licenses/Bun.md', 'Bun.md'],
  ['node_modules/ws/LICENSE', 'ws.txt'],
  ['../client/public/assets/fonts/OFL-Geist.txt', 'Geist.txt'],
  ['../client/public/assets/fonts/OFL-Geist-Mono.txt', 'Geist-Mono.txt'],
]) copyFileSync(join(here, source), join(pack, 'licenses', name));
writeFileSync(join(pack, 'package.json'), JSON.stringify({
  name: `@redcrayonai/draw-${process.platform}-${process.arch}`, version,
  description: `Draw executable for ${process.platform} ${process.arch}`,
  license: 'Apache-2.0', os: [process.platform], cpu: [process.arch],
  ...(process.platform === 'linux' ? { libc: ['glibc'] } : {}),
  files: ['draw', 'licenses', 'LICENSE'],
  repository: manifest.repository, publishConfig: manifest.publishConfig,
}, null, 2) + '\n');
const archive = `draw-${process.platform}-${process.arch}.tgz`;
execFileSync('tar', ['-czf', join(output, archive), '-C', output, 'package']);
const [{ filename }] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: plugin, encoding: 'utf8' }));
writeFileSync(join(output, 'SHA256SUMS'), [archive, filename].map(name => `${createHash('sha256').update(readFileSync(join(output, name))).digest('hex')}  ${name}\n`).join(''));
process.stderr.write(`Executable: ${join(output, 'draw')}\nPlatform package: ${join(output, archive)}\nMain package: ${join(output, filename)}\n`);
