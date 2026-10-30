import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createWorker } from './app';
import { resetAuthCaches, sha256 } from './auth';
import { testEnv } from './test/env';
import { origins } from './env';
import { createServer } from './tools';
import { PLANS } from './user';

const keyId = 'd'.repeat(32);
const bearer = `rcak_${keyId}_${'e'.repeat(64)}`;
const STR = { String: [] }, U64 = { U64: [] };
const table = (columns: [string, unknown][], rows: unknown[][]) => Response.json([{
  schema: { elements: columns.map(([name, type]) => ({ name: { some: name }, algebraic_type: type })) }, rows,
}]);
beforeEach(() => resetAuthCaches());
afterEach(() => { vi.unstubAllGlobals(); delete PLANS['self-hosted']; });

it('the tool server enforces scopes when used without the HTTP scope preflight', async () => {
  const env = await testEnv();
  const write = vi.fn();
  const server = createServer({
    env, o: origins(env), principal: { userId: 'machine:1', clientId: 'key', via: 'service', scopes: ['board:read'] },
    db: { stats: { writes: 0, dbCalls: 0, dbMs: 0 }, call: write }, log: () => {},
  } as never);
  const client = new Client({ name: 'scope-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'move_node', arguments: { board: '1', nodeId: '2', x: 0, y: 0 } });
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('credential does not allow') }] });
    expect(write).not.toHaveBeenCalled();
  } finally { await Promise.all([client.close(), server.close()]); }
});

it('the shared Worker entry checks managed keys fresh and uses a machine identity without linking a person', async () => {
  let role: string | undefined = 'editor';
  const calls: { reducer: string; sub: string }[] = [];
  const hash = await sha256(bearer);
  let lookups = 0;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const sub = JSON.parse(atob(String((init.headers as Record<string, string>).authorization).split('.')[1])).sub;
    if (String(init.body).includes('service_workspace_api_keys')) {
      expect(sub).toBe('service:mcp');
      expect(String(init.body)).toContain(hash);
      expect(String(init.body)).not.toContain(bearer);
      lookups++;
      return table([
        ['key_id', STR], ['key_hash', STR], ['workspace_id', U64], ['service_account_id', U64], ['name', STR], ['role', STR],
      ], role ? [[keyId, hash, 44, 9, 'Build bot', role]] : []);
    }
    calls.push({ reducer: new URL(_url).pathname.split('/').pop()!, sub });
    return new Response('');
  });
  const fallback = vi.fn(async () => null);
  const directory = vi.fn(async () => ({ name: 'Employee', plan: 'self-hosted' }));
  const worker = createWorker({ verifyBearer: () => fallback, users: () => directory });
  // Distinct limits make an accidental cloud-to-self-hosted plan change observable.
  PLANS['self-hosted'] = { callsPerMonth: 1 };
  const charge = vi.fn(async () => ({ ok: true, used: 1 }));
  const ledger = { charge };
  const env = await testEnv({ USER: { idFromName: (name: string) => name, get: () => ledger } as never });
  const call = (name: string) => worker.fetch(new Request('https://mcp.redcrayon.test/mcp', {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
  }), env);

  const allowed = await call('describe_charts');
  expect(allowed.status).toBe(200);
  expect(await allowed.text()).not.toContain('"isError":true');
  expect(charge).toHaveBeenCalledWith(expect.any(String), PLANS.free.callsPerMonth);
  expect(directory).not.toHaveBeenCalled();
  expect(calls).toEqual([{ reducer: 'join_board', sub: `machine:${keyId}` }]);
  role = 'viewer';
  expect((await call('create_node')).status).toBe(403);
  role = undefined;
  expect((await call('describe_charts')).status).toBe(401);
  expect(lookups).toBe(3);
  expect(fallback).not.toHaveBeenCalled();
});
