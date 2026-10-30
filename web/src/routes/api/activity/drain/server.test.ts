// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { env } from '$env/dynamic/private';
import { POST } from './+server';

const KEYS = ['DATABASE_URL', 'SPACETIMEDB_URL', 'SPACETIMEDB_DB', 'SPACETIMEDB_SERVICE_TOKEN'];
const saved = KEYS.map((k) => env[k]);
afterEach(() => KEYS.forEach((k, i) => (env[k] = saved[i])));

async function post(token?: string) {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const res = await POST({ request: new Request('http://dash.test/api/activity/drain', { method: 'POST', headers }) } as unknown as Parameters<typeof POST>[0]);
  return { status: res.status, body: await res.json() };
}

it('answers 503 when activity is not configured', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  Object.assign(env, { DATABASE_URL: '', SPACETIMEDB_URL: '', SPACETIMEDB_DB: '', SPACETIMEDB_SERVICE_TOKEN: '' });
  expect(await post('anything')).toEqual({ status: 503, body: { error: 'Activity is not set up on this deployment yet.' } });
  log.mockRestore();
});

it('refuses any bearer but the service token, before touching storage', async () => {
  Object.assign(env, { DATABASE_URL: 'postgres://nowhere.invalid/db', SPACETIMEDB_URL: 'http://stdb.test', SPACETIMEDB_DB: 'dash', SPACETIMEDB_SERVICE_TOKEN: 'svc' });
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  for (const token of [undefined, 'user-tok', 'svc2']) {
    expect(await post(token)).toEqual({ status: 401, body: { error: 'Invalid drain credentials.' } });
  }
  expect(fetchMock).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
