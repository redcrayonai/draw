import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLocalLive } from './local-live';
import { localCall } from './local-mcp';
import { LOCAL_REQUEST_BYTES } from '../../shared/local';

vi.mock('./local-mcp', () => ({ localEndpoint: () => ({}), localCall: vi.fn(async (_endpoint, input) => ({ accepted: input.events.length, rejected: {} })) }));
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function input(mapping: object, lines: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'draw-live-')); directories.push(directory);
  const file = join(directory, 'mapping.json'); writeFileSync(file, JSON.stringify(mapping));
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { for (const line of lines) yield Buffer.from(line + '\n'); return undefined; });
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  return ['--board', 'board', '--map', file];
}
it('splits full wire requests at the byte limit including mapping and escaped multibyte events', async () => {
  const mapping = { ['m'.repeat(LOCAL_REQUEST_BYTES - 1000)]: '1' };
  const event = JSON.stringify({ from: 'é'.repeat(200), to: 'é'.repeat(200) });
  expect(await runLocalLive(input(mapping, Array(3).fill(event)))).toBe(0);
  const requests = vi.mocked(localCall).mock.calls.map(([, value]) => value as { events: unknown[]; flush: boolean });
  expect(requests.reduce((n, request) => n + request.events.length, 0)).toBe(3);
  expect(requests.filter(request => request.events.length)).toHaveLength(3);
  expect(requests.at(-1)?.flush).toBe(true);
  for (const request of requests) expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(LOCAL_REQUEST_BYTES);
});
it('rejects a mapping whose envelope alone exceeds the server limit before making a request', async () => {
  const args = input({ ['m'.repeat(LOCAL_REQUEST_BYTES - 15)]: '1' }, []);
  await expect(runLocalLive(args)).rejects.toThrow('mapping');
  expect(localCall).not.toHaveBeenCalled();
});
