import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { createServer } from './tools';
import { UserLedger } from './user';
import { memoryCaptures, testEnv } from './test/env';
import { origins } from './env';
import { sealCapture } from './captures';

async function fixture() {
  const env = await testEnv();
  const captures = memoryCaptures();
  const ledger = new UserLedger({ get: async () => undefined, put: async () => {} });
  const roles = new Map<string, string>();
  const nodes: Record<string, unknown>[] = [];
  const clients: { client: Client; server: ReturnType<typeof createServer> }[] = [];
  const repoRoot = '/private/company-repository', sha = 'a'.repeat(40);
  const capture = 'cap_' + 'x'.repeat(22);
  await captures(capture).put(await sealCapture(capture, JSON.stringify({ v: 1, helper: '1.0.0', kind: 'start', toplevel: repoRoot, objectFormat: 'sha1', head: sha })));
  const connect = async (keyId: string, role: string) => {
    roles.set(keyId, role);
    const db = {
      stats: { dbCalls: 0, dbMs: 0, writes: 0 },
      read: async ({ text }: { text: string }) => {
        const role = roles.get(keyId);
        if (text.includes('visible_board')) return role ? [{ id: 1n, name: 'Private board', slug: 'abc' }] : [];
        if (text.includes('my_boards')) return role ? [{ boardId: 1n, access: role === 'editor' ? 'grant' : 'link', isSession: true }] : [];
        if (text.includes('visible_session')) return [{ boardId: 1n, repoRoot, baseSha: sha, checkpoint: 0 }];
        if (text.includes('visible_selection')) return [];
        if (text.includes('visible_node')) return role ? nodes : [];
        throw new Error(`unexpected read ${text}`);
      },
      call: async (name: string, args: Record<string, unknown>) => {
        if (name === 'create_node') {
          if (roles.get(keyId) !== 'editor') throw new Error('module denied write');
          nodes.push({ ...args, id: BigInt(nodes.length + 1) });
        }
      },
    };
    const server = createServer({
      env, o: origins(env), principal: { userId: 'machine:44', clientId: keyId, via: 'service', scopes: ['board:read', 'board:write'], machine: { keyId, serviceAccountId: '44', workspaceId: '9', name: 'CI bot' } },
      db, ledger, captures, quota: { check: async () => true }, user: async () => ({ name: 'CI bot', plan: 'free' }), log: () => {},
    } as never);
    const client = new Client({ name: keyId, version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    clients.push({ client, server });
    return async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
      return { text: result.content[0].text, isError: result.isError === true };
    };
  };
  return { connect, capture, repoRoot, roles, nodes, close: async () => Promise.all(clients.flatMap(({ client, server }) => [client.close(), server.close()])) };
}

it('never replays capture responses to another key or after current board access is narrowed', async () => {
  const f = await fixture();
  try {
    const first = await f.connect('first', 'editor'), second = await f.connect('second', '');
    const args = { link: '1', capture: f.capture };
    expect((await first('start_session', args)).text).toContain(f.repoRoot);
    expect((await first('start_session', args)).text).toContain('same call');
    expect(await second('start_session', args)).toMatchObject({ isError: true, text: expect.not.stringContaining(f.repoRoot) });
    f.roles.set('first', '');
    expect(await first('start_session', args)).toMatchObject({ isError: true, text: expect.not.stringContaining(f.repoRoot) });
    // Simulates a policy change after HTTP auth, while the request waited for a pending cache entry.
    f.roles.set('first', 'viewer');
    expect(await first('start_session', args)).toMatchObject({ isError: true, text: expect.not.stringContaining(f.repoRoot) });
  } finally { await f.close(); }
});

it('keeps create deduplication per key and checks current edit rights before replay', async () => {
  const f = await fixture();
  try {
    const first = await f.connect('first', 'editor'), second = await f.connect('second', 'editor');
    const args = { board: '1', label: 'CI', sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false };
    expect((await first('create_node', args)).isError).toBe(false);
    expect((await second('create_node', args)).isError).toBe(false);
    expect(f.nodes).toHaveLength(2);
    f.roles.set('first', 'viewer');
    expect((await first('create_node', args)).isError).toBe(true);
  } finally { await f.close(); }
});
