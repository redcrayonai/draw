import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { checkUpdate, newer, notifyUpdate, updateMessage } from './update';
const directories: string[] = [];
function cache() { const dir = mkdtempSync(join(tmpdir(), 'draw-update-')); directories.push(dir); return join(dir, 'check.json'); }
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const metadata = (version = '1.2.3') => ({ name: '@redcrayonai/draw', version, drawRuntime: { protocol: 1 }, optionalDependencies: { [`@redcrayonai/draw-${process.platform}-${process.arch}`]: version } });

it.each([
  ['1.10.0', '1.9.0', true], ['1.0.0', '1.0.0+local.abc', false], ['1.0.0', '1.0.0-rc.2', true],
  ['1.0.0-rc.10', '1.0.0-rc.2', true], ['1.0.0-1', '1.0.0-beta', false], ['1.0.0-beta.1', '1.0.0-beta', true],
  ['1.0.0-beta', '1.0.0', false], ['1.0.0', '2.0.0', false], ['1.0.0-rc.1', '1.0.0-rc.1', false],
])('compares %s against %s without promoting build metadata', (a, b, expected) => expect(newer(a, b)).toBe(expected));
it.each(['1.0.0;echo bad', '01.2.3', '1.2.3-01', '1.0.0\nBAD', '1.0.0\n', '9999999999999999999.0.0'])('rejects invalid release %s', version => expect(() => newer(version, '1.0.0')).toThrow('invalid release'));
it('caches a successful check for one day, and explicit checks bypass the cache', async () => {
  const request = vi.fn().mockImplementation(async () => Response.json(metadata())); vi.stubGlobal('fetch', request);
  const path = cache(); const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  expect((await checkUpdate('stable', false, path)).version).toBe('1.2.3');
  await checkUpdate('stable', false, path); expect(request).toHaveBeenCalledTimes(1);
  now.mockReturnValue(1_000_000 + 86_400_000); await checkUpdate('stable', false, path); expect(request).toHaveBeenCalledTimes(2);
  await checkUpdate('stable', true, path); expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.calls[0][0]).toContain('/latest');
});
it('handles old hosted packages, missing native releases, and unavailable platforms honestly', async () => {
  const request = vi.fn().mockResolvedValueOnce(Response.json({ name: '@redcrayonai/draw', version: '9.0.0' }))
    .mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce(Response.json({ ...metadata(), optionalDependencies: {} })); vi.stubGlobal('fetch', request);
  const path = cache();
  expect((await checkUpdate('stable', true, path)).state).toBe('unpublished');
  expect((await checkUpdate('stable', true, path)).state).toBe('unpublished');
  expect((await checkUpdate('stable', true, path)).state).toBe('unsupported');
});
it('selects preview explicitly and never recommends a prerelease on stable', async () => {
  const request = vi.fn().mockImplementation(async () => Response.json(metadata('2.0.0-beta.1'))); vi.stubGlobal('fetch', request);
  expect((await checkUpdate('preview', false, cache())).version).toBe('2.0.0-beta.1'); expect(request.mock.calls[0][0]).toContain('/next');
  expect((await checkUpdate('stable', false, cache())).state).toBe('unavailable');
});
it('silently caches failures and recovers from corrupt or future-dated cache data', async () => {
  const request = vi.fn().mockRejectedValue(new Error('offline')); vi.stubGlobal('fetch', request);
  const path = cache(); writeFileSync(path, 'not json');
  expect((await checkUpdate('stable', false, path)).state).toBe('unavailable');
  await checkUpdate('stable', false, path); expect(request).toHaveBeenCalledTimes(1);
  writeFileSync(path, JSON.stringify({ checkedAt: Date.now() + 86_400_000, state: 'available', version: '999.0.0' }));
  await checkUpdate('stable', false, path); expect(request).toHaveBeenCalledTimes(2);
  expect(JSON.parse(readFileSync(path, 'utf8')).state).toBe('unavailable');
});
it('does not cache an unfinished request as a failed check', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const path = cache(), pending = checkUpdate('stable', false, path);
  expect(existsSync(path)).toBe(false);
  finish(Response.json(metadata()));
  await pending;
  expect(JSON.parse(readFileSync(path, 'utf8')).state).toBe('available');
});
it('bounds metadata and rejects control characters before showing a notice', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('x'.repeat(128 * 1024 + 1)))
    .mockResolvedValueOnce(Response.json(metadata('9.0.0\u001b[31m'))));
  expect((await checkUpdate('stable', true, cache())).state).toBe('unavailable');
  expect((await checkUpdate('stable', true, cache())).state).toBe('unavailable');
});
it('does not contact the registry in noninteractive, CI, or opted-out sessions', async () => {
  const request = vi.fn(); vi.stubGlobal('fetch', request);
  const stderr = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY'), stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  try {
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: false });
    await notifyUpdate('1.0.0');
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    vi.stubEnv('CI', 'true'); await notifyUpdate('1.0.0');
    vi.stubEnv('CI', ''); vi.stubEnv('DRAW_NO_UPDATE_CHECK', '1'); await notifyUpdate('1.0.0');
    expect(request).not.toHaveBeenCalled();
  } finally {
    if (stderr) Object.defineProperty(process.stderr, 'isTTY', stderr); else delete (process.stderr as { isTTY?: boolean }).isTTY;
    if (stdin) Object.defineProperty(process.stdin, 'isTTY', stdin); else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
});
it('explains failures without claiming a successful check or exposing network details', () => {
  expect(updateMessage({ checkedAt: 0, state: 'unavailable' }, '1.0.0')).toContain('could not check');
  expect(updateMessage({ checkedAt: 0, state: 'available', version: '2.0.0' }, '1.0.0')).toContain('draw update');
  expect(updateMessage({ checkedAt: 0, state: 'available', version: '2.0.0-beta.1' }, '1.0.0', 'preview')).toContain('draw update --channel preview');
});
