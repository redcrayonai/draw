import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { MAX_LOCAL_VIEWER_BYTES, sendLocalEvent, startLocal } from './local-server';

const cleanup: (() => Promise<void>)[] = [];
it('bounds stalled viewer queues without disconnecting on ordinary stream backpressure', () => {
  const response = { writableLength: 0, write: vi.fn(() => false), destroy: vi.fn() };
  expect(sendLocalEvent(response as never, 'x'.repeat(64000))).toBe(true);
  expect(response.destroy).not.toHaveBeenCalled();
  response.writableLength = MAX_LOCAL_VIEWER_BYTES - 1;
  expect(sendLocalEvent(response as never, 'é')).toBe(false);
  expect(response.write).toHaveBeenCalledTimes(1); expect(response.destroy).toHaveBeenCalledOnce();
});
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'draw-server-'));
  const repo = join(directory, 'repo'); mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'code.ts'), 'export const value = 1;\n');
  writeFileSync(join(repo, '.env'), 'PRIVATE=secret');
  writeFileSync(join(directory, 'outside.ts'), 'outside');
  symlinkSync(join(directory, 'outside.ts'), join(repo, 'escape.ts'));
  const app = await startLocal({ repo, directory: join(directory, 'store'), assets: directory });
  cleanup.push(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = async (input: unknown) => {
    const response = await fetch(`${app.origin}/api/call`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}` }, body: JSON.stringify(input) });
    return { status: response.status, value: await response.json() as any };
  };
  return { app, call };
}
it('uses the same committed state for tools and browser updates', async () => {
  const { app, call } = await setup();
  const { value: board } = await call({ action: 'open_board', name: 'Local' });
  const abort = new AbortController();
  const events = await fetch(`${app.origin}/api/events?board=${board.slug}`, { headers: { Authorization: `Bearer ${app.token}` }, signal: abort.signal });
  const reader = events.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('"revision":0');
  expect((await call({ action: 'apply_board', board: board.slug, revision: 0, operations: [{ type: 'node.put', patch: { label: 'API', x: 128 } }] })).status).toBe(200);
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('"x":128');
  abort.abort();
  const { value: read } = await call({ action: 'read_board', board: board.slug });
  expect(read.nodes[0].x).toBe(128);
});
it('requires a capability and rejects foreign origins and hosts', async () => {
  const { app } = await setup();
  const url = `${app.origin}/api/call`;
  expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401);
  expect((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, Origin: 'https://untrusted.example' }, body: '{}' })).status).toBe(403);
  const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, Host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  expect(foreignHost).toBe(403);
  const session = await fetch(`${app.origin}/session`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, Origin: app.origin } });
  expect(session.status).toBe(204);
  expect(session.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
});
it('reads in-repo code and refuses traversal, secrets, missing files and escaping symlinks', async () => {
  const { call } = await setup();
  const { value: board } = await call({ action: 'open_board', name: 'Refs' });
  const read = (path: string) => call({ action: 'read_code', board: board.slug, ref: { path, start: 1, end: 1 } });
  expect((await read('code.ts')).value.text).toBe('export const value = 1;');
  for (const path of ['../outside.ts', '.env', 'missing.ts', 'escape.ts']) expect((await read(path)).status).toBe(400);
});
it('returns a usable private board link without storing its capability in the board', async () => {
  const { app, call } = await setup();
  const { value: board } = await call({ action: 'open_board', name: 'Local link' });
  const url = new URL(board.url);
  expect(url.origin).toBe(app.origin);
  expect(url.hash).toBe(`#b=${board.slug}&key=${app.token}`);
  const read = (await call({ action: 'read_board', board: board.slug })).value;
  expect(read.url).toBe(board.url);
  expect(read.connection.connected).toBe(false);
  await call({ action: 'connect_local_agent', board: board.slug, agent: 'pi', threadId: 'current-pi', cwd: board.repo });
  expect((await call({ action: 'read_board', board: board.slug })).value.connection.session.id).toBe('pi:current-pi');
  expect(JSON.stringify(app.store.read(board.slug))).not.toContain(app.token);
});
