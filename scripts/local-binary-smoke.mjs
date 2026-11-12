// Exercise real npm/Bun resolution against an isolated registry; nothing is published.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);
const platformArchive = resolve(process.argv[2]), mainArchive = resolve(process.argv[3]);
const bun = process.argv[4] ?? 'bun';
const directory = mkdtempSync(join(tmpdir(), 'draw install '));
const packages = new Map(), requestedArchives = new Set();
const server = createServer((request, response) => {
  const path = decodeURIComponent(request.url.split('?')[0]);
  const entry = packages.get(path.replace(/^\//, ''));
  if (entry) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(entry));
  } else if (path.startsWith('/tarballs/')) {
    requestedArchives.add(path);
    const archive = path === `/tarballs/${basename(mainArchive)}` ? mainArchive : path === `/tarballs/${basename(platformArchive)}` ? platformArchive : null;
    if (archive) { response.end(readFileSync(archive)); return; }
    response.writeHead(404).end();
  } else response.writeHead(404).end();
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const registry = `http://127.0.0.1:${server.address().port}`;
  const extract = async (archive, destination) => {
    mkdirSync(destination);
    await run('tar', ['-xzf', archive, '-C', destination]);
    return JSON.parse(readFileSync(join(destination, 'package/package.json'), 'utf8'));
  };
  const main = await extract(mainArchive, join(directory, 'main'));
  const native = await extract(platformArchive, join(directory, 'native'));
  assert.equal(main.name, '@redcrayonai/draw');
  assert.equal(native.name, `${main.name}-${process.platform}-${process.arch}`);
  assert.equal(main.version, native.version);
  assert.equal(main.drawRuntime.protocol, 1);
  assert.equal(main.scripts, undefined);
  assert.equal(native.scripts, undefined);
  assert.equal(native.dependencies, undefined);
  assert.equal(Object.keys(main.optionalDependencies).length, 4);
  assert(Object.values(main.optionalDependencies).every(version => version === main.version));
  for (const name of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'bin/redcrayon.mjs', 'bin/chat-hook.mjs', 'pi/extension.mjs']) {
    assert(readFileSync(join(directory, 'main/package', name)).length, name);
  }
  const register = (manifest, archive) => {
    const dist = { tarball: `${registry}/tarballs/${basename(archive)}` };
    if (archive === mainArchive || archive === platformArchive) dist.integrity = `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`;
    const version = { ...manifest, dist };
    packages.set(manifest.name, { name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: version } });
  };
  register(main, mainArchive);
  for (const name of Object.keys(main.optionalDependencies)) {
    const [, platform, arch] = name.match(/draw-(darwin|linux)-(arm64|x64)$/);
    register({ ...native, name, os: [platform], cpu: [arch] }, name === native.name ? platformArchive : `${platform}-${arch}.tgz`);
  }
  for (const installer of ['npm', 'bun']) {
    const prefix = join(directory, installer), bin = join(prefix, 'bin');
    mkdirSync(prefix);
    const env = { ...process.env, npm_config_userconfig: '/dev/null', npm_config_cache: join(prefix, 'cache'), BUN_INSTALL_CACHE_DIR: join(prefix, 'cache') };
    if (installer === 'npm') {
      await run('npm', ['install', '--global', '--prefix', prefix, '--registry', registry, '--ignore-scripts', '--no-audit', '--no-fund', `${main.name}@${main.version}`], { cwd: prefix, env });
    } else {
      const config = join(prefix, 'bunfig.toml');
      writeFileSync(config, `[install]\nregistry = ${JSON.stringify(registry)}\nglobalDir = ${JSON.stringify(join(prefix, 'global'))}\nglobalBinDir = ${JSON.stringify(bin)}\n`);
      await run(bun, ['install', '--global', `--config=${config}`, '--registry', registry, '--ignore-scripts', `${main.name}@${main.version}`], { cwd: prefix, env });
    }
    const runtimeEnv = { ...process.env, PATH: bin, DRAW_NO_UPDATE_CHECK: '1' };
    const invoke = (command, args, options = {}) => run(join(bin, command), args, { cwd: prefix, env: runtimeEnv, ...options });
    const version = (await invoke('draw', ['--version'])).stdout;
    assert(version.includes(main.version), version);
    assert.equal((await invoke('redcrayon', ['--version'])).stdout, version);
    assert.match((await invoke('draw', ['--help'])).stdout, /draw install/);
    const child = execFile(join(bin, 'draw'), ['local-mcp', '--per-repo'], { cwd: prefix, env: runtimeEnv, timeout: 30_000 });
    const response = new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      child.stdout.on('data', text => { stdout += text; });
      child.stderr.on('data', text => { stderr += text; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    assert(JSON.parse(await response).result.tools.some(tool => tool.name === 'attach_conversation'));
    const settings = JSON.parse((await invoke('draw', ['local-claude-settings', '--board', 'test', '--repo', prefix])).stdout);
    assert(!settings.hooks.SessionStart[0].hooks[0].command.includes('/$bunfs/'));
    assert(settings.hooks.SessionStart[0].hooks[0].command.includes('local-claude-hook'));
    console.log(`PASS: ${installer} resolved the native optional package; draw, redcrayon, MCP, and hook settings work without Node or Bun on PATH.`);
  }
  assert.deepEqual([...requestedArchives].sort(), [`/tarballs/${basename(mainArchive)}`, `/tarballs/${basename(platformArchive)}`].sort());
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
