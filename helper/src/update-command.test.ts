import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { detectInstaller, integrationNotices, runUpdate } from './update';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
const dirs: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), 'draw-update-command-')); dirs.push(path); return path; }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.mocked(execFileSync).mockReset(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function release() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ name: '@redcrayonai/draw', version: '2.0.0', drawRuntime: { protocol: 1 }, optionalDependencies: { [`@redcrayonai/draw-${process.platform}-${process.arch}`]: '2.0.0' } })));
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
}
it('checks without installing, and installs an exact version only on explicit update', async () => {
  release(); const cache = join(directory(), 'cache.json');
  expect(await runUpdate(['--check', '--installer', 'npm'], '1.0.0', cache)).toBe(0);
  expect(execFileSync).not.toHaveBeenCalled();
  expect(await runUpdate(['--installer', 'bun'], '1.0.0', cache)).toBe(0);
  expect(execFileSync).toHaveBeenCalledWith('bun', ['install', '--global', '--ignore-scripts', '@redcrayonai/draw@2.0.0'], { stdio: 'inherit' });
});
it('never downgrades and reports install failure without restarting sessions', async () => {
  release(); const cache = join(directory(), 'cache.json');
  expect(await runUpdate(['--installer', 'npm'], '3.0.0', cache)).toBe(0); expect(execFileSync).not.toHaveBeenCalled();
  vi.mocked(execFileSync).mockImplementation(() => { throw new Error('failure'); });
  expect(await runUpdate(['--installer', 'npm'], '1.0.0', cache)).toBe(1);
  expect(execFileSync).toHaveBeenCalledTimes(1);
});
it('rejects unsupported flags before contacting any service', async () => {
  release(); expect(await runUpdate(['--installer', 'sh'], '1.0.0', join(directory(), 'cache'))).toBe(1);
  expect(fetch).not.toHaveBeenCalled(); expect(execFileSync).not.toHaveBeenCalled();
});
it('detects the manager only when its global launcher resolves to this executable', () => {
  const dir = directory(), binary = join(dir, 'draw'), root = join(dir, 'node_modules'), launcher = join(root, '@redcrayonai/draw/bin/draw');
  writeFileSync(binary, ''); mkdirSync(join(root, '@redcrayonai/draw/bin'), { recursive: true }); writeFileSync(launcher, '');
  writeFileSync(join(root, '@redcrayonai/draw/package.json'), JSON.stringify({ name: '@redcrayonai/draw', drawRuntime: { protocol: 1 }, bin: { draw: 'bin/draw' } }));
  vi.mocked(execFileSync).mockReturnValueOnce(root).mockReturnValueOnce(binary);
  expect(detectInstaller(binary)).toBe('npm');
  vi.mocked(execFileSync).mockReset().mockReturnValueOnce(root).mockReturnValueOnce(join(dir, 'elsewhere')).mockImplementation(() => { throw new Error('missing'); });
  expect(detectInstaller(binary)).toBeUndefined();
});
it('flags stale integrations using successful install receipts only', () => {
  const dir = directory();
  writeFileSync(join(dir, 'pi-local.json'), JSON.stringify({ agent: 'pi', mode: 'local', version: '1.0.0', protocol: 1 }));
  writeFileSync(join(dir, 'codex-hosted.json'), JSON.stringify({ agent: 'codex', mode: 'hosted', version: '2.0.0', protocol: 1 }));
  writeFileSync(join(dir, 'claude-code-local.json'), 'incomplete');
  expect(integrationNotices('2.0.0', dir)).toEqual(['Refresh your pi local integration for Draw 2.0.0: draw install pi --mode local']);
});
