// Install the native tarball with Bun in isolated global directories; no install scripts or runtime dependencies.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const archive = resolve(process.argv[2]), bun = process.argv[3] ?? 'bun';
const directory = mkdtempSync(join(tmpdir(), 'draw-bun-install-'));
try {
  const config = join(directory, 'bunfig.toml'), bin = join(directory, 'bin');
  writeFileSync(config, `[install]\nglobalDir = ${JSON.stringify(join(directory, 'global'))}\nglobalBinDir = ${JSON.stringify(bin)}\n`);
  execFileSync(bun, ['install', '--global', `--config=${config}`, archive], { stdio: 'pipe', encoding: 'utf8' });
  const draw = join(bin, 'draw');
  const env = { ...process.env, PATH: bin };
  assert.match(execFileSync(draw, ['--version'], { env, encoding: 'utf8' }), /^draw /);
  assert.match(execFileSync(draw, ['--help'], { env, encoding: 'utf8' }), /draw install codex/);
  assert.match(readFileSync(join(directory, 'global/node_modules/@redcrayonai/draw-local/local-pi-extension.mjs'), 'utf8'), /export/);
  const manifest = JSON.parse(readFileSync(join(directory, 'global/node_modules/@redcrayonai/draw-local/package.json')));
  assert.equal(manifest.scripts, undefined); assert.equal(manifest.dependencies, undefined);
  const response = execFileSync(draw, ['local-mcp', '--per-repo'], { env, encoding: 'utf8', input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n' });
  assert(JSON.parse(response).result.tools.some(tool => tool.name === 'attach_conversation'));
  const settings = JSON.parse(execFileSync(draw, ['local-claude-settings', '--board', 'test', '--repo', directory], { env, encoding: 'utf8' }));
  assert(!settings.hooks.SessionStart[0].hooks[0].command.includes('/$bunfs/'));
  assert(settings.hooks.SessionStart[0].hooks[0].command.includes('local-claude-hook'));
  console.log('PASS: Bun installed the native tarball; CLI, MCP, and hook launcher work with no Node or Bun on PATH.');
} finally { rmSync(directory, { recursive: true, force: true }); }
