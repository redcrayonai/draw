import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, ipKey, MARKS_WAIT_MS, MAX_BODY } from './app';
import { mintMarks, mintTap } from './issuer';
import { resetAuthCaches, type VerifyBearer } from './auth';
import type { Env } from './env';
import { TOOL_NAMES } from './tools';
import { memoryCaptures, testEnv } from './test/env';
import { identityFromClaims } from '../../shared/identity';
import { MAX_BODY_BYTES } from '../../shared/capture';
import { DbError } from '../../shared/db-http';

const verifyBearer: VerifyBearer = async auth => {
  if (auth === 'Bearer tok_ok') return { userId: 'user_1', clientId: 'client_a', via: 'oauth', scopes: ['board:read', 'board:write'] };
  if (auth === 'Bearer tok_read') return { userId: 'user_2', clientId: 'client_b', via: 'oauth', scopes: ['board:read'] };
  return null;
};
const app = createApp({
  verifyBearer,
  users: async () => ({ name: 'Ada', plan: 'free' }),
  ledger: () => ({ charge: async () => ({ ok: true, used: 1 }), claim: async () => ({ first: true }), settle: async () => {} }),
  fetchMetadata: async () => new Response('{"issuer":"https://auth.redcrayon.test"}'),
  captures: memoryCaptures(),
});

const BASE = 'https://mcp.redcrayon.test';

// A 2025-era POST answers with one SSE message event; a modern one with JSON.
async function rpcBody(res: Response) {
  const text = await res.text();
  const data = text.startsWith('event:') ? text.split('\n').find(l => l.startsWith('data: '))!.slice(6) : text;
  return JSON.parse(data);
}
let env: Env;
beforeEach(async () => {
  resetAuthCaches();
  env = await testEnv();
});

const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(`${BASE}${path}`, { headers }), env);
const rpc = (body: unknown, token = 'tok_ok', extra: Record<string, string> = {}) =>
  app.fetch(
    new Request(`${BASE}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...extra },
      body: JSON.stringify(body),
    }),
    env
  );

describe('routes', () => {
  it('answers only on its own host and paths', async () => {
    expect((await app.fetch(new Request('https://evil.test/mcp', { method: 'POST' }), env)).status).toBe(404);
    const res = await get('/anything');
    expect(res.status).toBe(404);
    expect((await res.json()) as any).toEqual({ error: 'not_found' });
  });

  it('serves the protected-resource metadata byte for byte, on both paths', async () => {
    const expected = '{"resource":"https://mcp.redcrayon.test/mcp","authorization_servers":["https://auth.redcrayon.test"],"scopes_supported":["board:read","board:write"]}';
    expect(await (await get('/.well-known/oauth-protected-resource/mcp')).text()).toBe(expected);
    expect(await (await get('/.well-known/oauth-protected-resource')).text()).toBe(expected);
  });

  it("copies the identity provider's authorization-server metadata", async () => {
    expect((await (await get('/.well-known/oauth-authorization-server')).json()) as any).toEqual({ issuer: 'https://auth.redcrayon.test' });
  });

  it('publishes issuer discovery and the JWKS with a 5 minute cache', async () => {
    const d = await get('/agent-id/.well-known/openid-configuration');
    expect(d.headers.get('cache-control')).toBe('public, max-age=300');
    expect((await d.json()) as any).toMatchObject({ issuer: `${BASE}/agent-id`, jwks_uri: `${BASE}/agent-id/jwks.json` });
    expect(((await (await get('/agent-id/jwks.json')).json()) as any).keys).toHaveLength(1);
  });

  it('GET and DELETE /mcp are 405; there is no SSE', async () => {
    expect((await get('/mcp')).status).toBe(405);
    expect((await app.fetch(new Request(`${BASE}/mcp`, { method: 'DELETE' }), env)).status).toBe(405);
  });
});

describe('CORS', () => {
  it.each([
    ['no Origin', undefined, 200],
    ['an https origin', 'https://claude.ai', 200],
    ['an http origin', 'http://evil.test', 403],
    ['localhost outside dev', 'http://localhost:6274', 403],
  ])('%s', async (_n, origin, status) => {
    const res = await get('/.well-known/oauth-protected-resource', origin ? { origin } : {});
    expect(res.status).toBe(status);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-expose-headers')).toBe('WWW-Authenticate, Mcp-Session-Id');
  });

  it('in dev only localhost origins are let in: any web page could act as user_dev otherwise', async () => {
    env = { ...env, DEV_AUTH: '1' };
    expect((await get('/.well-known/oauth-protected-resource', { origin: 'http://localhost:6274' })).status).toBe(200);
    expect((await get('/.well-known/oauth-protected-resource', { origin: 'https://evil.test' })).status).toBe(403);
  });
});

describe('/mcp auth', () => {
  it('401 without a token: the exact header and body', async () => {
    const res = await app.fetch(new Request(`${BASE}/mcp`, { method: 'POST', body: '{}' }), env);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="board:read board:write"`
    );
    expect(await res.text()).toBe('{"error":"invalid_token","error_description":"Sign in to redcrayon from your agent\'s MCP settings."}');
  });

  it('401 for an expired or banned token says the sign-in ended', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'tok_banned');
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error_description).toBe("Your redcrayon sign-in ended. Sign in again from your agent's MCP settings.");
  });

  it('403 when a write tool is called without board:write', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_node', arguments: {} } }, 'tok_read');
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toBe('Bearer error="insufficient_scope", scope="board:write"');
    expect(((await res.json()) as any).error_description).toBe('This sign-in cannot edit boards. Sign in again and allow editing.');
  });

  it('413 for a chunked body over 256 KB, with no Content-Length to check', async () => {
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < 6) c.enqueue(chunk);
        else c.close();
      },
    });
    const res = await app.fetch(new Request(`${BASE}/mcp`, { method: 'POST', headers: { authorization: 'Bearer tok_ok' }, body, duplex: 'half' } as RequestInit), env);
    expect(res.status).toBe(413);
  });

  it('413 over 256 KB', async () => {
    const res = await app.fetch(
      new Request(`${BASE}/mcp`, { method: 'POST', headers: { authorization: 'Bearer tok_ok' }, body: 'x'.repeat(MAX_BODY + 1) }),
      env
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error_description).toBe('Request too large: 256 KB maximum.');
  });
});

describe('MCP discovery', () => {
  it('initialize names redcrayon with the version and instructions', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(res.status).toBe(200);
    const body = await rpcBody(res);
    expect(body.result.serverInfo).toMatchObject({ name: 'draw', title: 'draw', version: 'abcdef123456' });
    expect(body.result.instructions.length).toBeLessThanOrEqual(2000);
  });

  it('tools/list returns the hosted tools', async () => {
    const body = await rpcBody(await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    expect(body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });
});

describe('tool calls', () => {
  afterEach(() => vi.unstubAllGlobals());

  // A cold isolate links and joins the agent first: those 2 writes are not the tool's.
  it("a failing first call on a cold isolate does not claim an earlier write", async () => {
    const posted: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      posted.push(new URL(url).pathname.split('/').pop()!);
      return new Response(url.endsWith('/sql') ? '[{"schema":{"elements":[]},"rows":[]}]' : '');
    });
    const body = await rpcBody(await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_board', arguments: { board: '42' } } }));
    expect(posted.slice(0, 2)).toEqual(['link_hosted_agent', 'join_board']);
    expect(body.result.content[0].text).toMatch(/^REJECTED: board 42 not found\. Nothing was written\./);
  });

  it('the quota is asked for 1 per call before anything is written, and its refusal is the answer', async () => {
    const posted: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => (posted.push(url), new Response('')));
    const check = vi.fn(async () => false);
    const charge = vi.fn(async () => ({ ok: true, used: 1 }));
    const metered = createApp({ verifyBearer, ledger: () => ({ charge, claim: async () => ({ first: true }), settle: async () => {} }), captures: memoryCaptures(), quota: { check } });
    const res = await metered.fetch(
      new Request(`${BASE}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok_ok', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_board', arguments: { board: '42' } } }),
      }),
      env
    );
    const body = await rpcBody(res);
    expect(check).toHaveBeenCalledWith('user_1', 1);
    expect(body.result.content[0].text).toBe('REJECTED: this account has no tool calls left. Nothing was written. To add more, write to support@redcrayon.test.');
    expect(posted).toEqual([]);
    expect(charge).not.toHaveBeenCalled(); // a refused call is not counted
  });

  it('with no user lookup, the agent is named by its user id', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(url.endsWith('/sql') ? '[{"schema":{"elements":[]},"rows":[]}]' : '');
    });
    // A user no earlier test joined: the join is once per user per isolate.
    const open = createApp({ verifyBearer: async () => ({ userId: 'user_sh', clientId: 'c', via: 'oauth', scopes: ['board:read'] }), ledger: () => ({ charge: async () => ({ ok: true, used: 1 }), claim: async () => ({ first: true }), settle: async () => {} }), captures: memoryCaptures() });
    const res = await open.fetch(
      new Request(`${BASE}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok_ok', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_board', arguments: { board: '42' } } }),
      }),
      env
    );
    await res.text();
    expect(bodies.some(b => b.includes('agent of user_sh'))).toBe(true);
  });

  // Auth0 and Entra v1 issuers end in '/': the person's database identity hashes that exact iss.
  it('links the agent to the owner identity of the exact issuer, trailing slash kept', async () => {
    const bodies: Record<string, string> = {};
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      bodies[new URL(url).pathname.split('/').pop()!] = String(init?.body ?? '');
      return new Response(url.endsWith('/sql') ? '[{"schema":{"elements":[]},"rows":[]}]' : '');
    });
    const slashed = await testEnv({ OIDC_ISSUER: 'https://tenant.auth0.test/' });
    // a user no earlier test linked: the link is once per user per isolate
    const app0 = createApp({ verifyBearer: async () => ({ userId: 'auth0|u1', clientId: 'c', via: 'oauth', scopes: ['board:read'] }), ledger: () => ({ charge: async () => ({ ok: true, used: 1 }), claim: async () => ({ first: true }), settle: async () => {} }), captures: memoryCaptures() });
    const call = (path: string, init: RequestInit = {}) => app0.fetch(new Request(`${BASE}${path}`, init), slashed);
    await (await call('/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer tok_ok', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_board', arguments: { board: '42' } } }),
    })).text();
    expect(JSON.parse(bodies.link_hosted_agent)[1]).toEqual({ __identity__: `0x${identityFromClaims('https://tenant.auth0.test/', 'auth0|u1')}` });
    expect(((await (await call('/.well-known/oauth-protected-resource/mcp')).json()) as any).authorization_servers).toEqual(['https://tenant.auth0.test/']);
  });

  it('wraps each call in a tool.<name> span carrying the outcome and the log line reqId', async () => {
    vi.stubGlobal('fetch', async (url: string) => new Response(url.endsWith('/sql') ? '[{"schema":{"elements":[]},"rows":[]}]' : ''));
    const spans: { name: string; attrs: Record<string, unknown>; status?: string }[] = [];
    const tracing = {
      enterSpan: (name: string, run: (span: Span) => unknown) => {
        const s: (typeof spans)[number] = { name, attrs: {} };
        spans.push(s);
        return run({ setAttributes: (a: Record<string, unknown>) => Object.assign(s.attrs, a), setStatus: (st: { code: string }) => (s.status = st.code) } as unknown as Span);
      },
    } as Pick<Tracing, 'enterSpan'>;
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const traced = createApp({ verifyBearer, users: async () => ({ name: 'Ada', plan: 'free' }), ledger: () => ({ charge: async () => ({ ok: true, used: 1 }), claim: async () => ({ first: true }), settle: async () => {} }), captures: memoryCaptures(), tracing });
    const res = await traced.fetch(
      new Request(`${BASE}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok_ok', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_board', arguments: { board: '42' } } }),
      }),
      env
    );
    await res.text(); // the call runs as the body streams
    const line = JSON.parse(String(logs.mock.calls.find(c => String(c[0]).includes('"tool":"get_board"'))![0]));
    logs.mockRestore();
    expect(spans).toEqual([{ name: 'tool.get_board', attrs: { tool: 'get_board', outcome: 'rejected', status: 200, reqId: line.reqId, cold: line.cold } }]);
  });

  // RC-690: an error message can carry database response text, and with it code.
  it('error logs carry the error name and a database status, never the message', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', async (url: string) =>
      url.endsWith('/link_hosted_agent') ? new Response('const secret = 1;', { status: 530 }) : new Response(url.endsWith('/sql') ? '[{"schema":{"elements":[]},"rows":[]}]' : ''));
    // a user no earlier test linked: the link is once per user per isolate
    const a = createApp({ verifyBearer: async () => ({ userId: 'user_logs', clientId: 'c', via: 'oauth', scopes: ['board:read'] }), ledger: () => ({ charge: async () => ({ ok: true, used: 1 }), claim: async () => ({ first: true }), settle: async () => {} }), captures: memoryCaptures() });
    await (await a.fetch(
      new Request(`${BASE}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok_ok', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_board', arguments: { board: '42' } } }),
      }),
      env
    )).text();
    const throwing = { ...env, IP_RL: { limit: async () => { throw new DbError(530, 'const secret = 2;'); } } } as unknown as Env;
    expect((await a.fetch(new Request(`${BASE}/.well-known/oauth-protected-resource`), throwing)).status).toBe(500);
    const lines = errors.mock.calls.map(c => JSON.parse(String(c[0])));
    errors.mockRestore();
    expect(lines.find(l => l.event === 'agent.link_failed')).toMatchObject({ ensureAgent: 'link', error: 'Error 530' });
    expect(lines.find(l => l.event === 'http.unhandled_error')).toMatchObject({ error: 'Error 530' });
    expect(JSON.stringify(lines)).not.toContain('secret');
  });
});

describe('ipKey', () => {
  it('keys IPv6 by its /64, so one host cannot rotate addresses past the limit', () => {
    expect(ipKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
  });

  // /facts takes an 8 MB upload with no sign-in, so its limit is the only thing holding it.
  it('every rate limit keys the caller the same way, /facts included', async () => {
    const keys: string[] = [];
    const counting = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) };
    const limited = await testEnv({ FACTS_RL: counting, IP_RL: counting });
    const upload = (ip: string) =>
      app.fetch(new Request(`${BASE}/facts`, { method: 'POST', headers: { 'cf-connecting-ip': ip }, body: '{"kind":"start"}' }), limited);
    await upload('2001:db8:1:2:aaaa::1');
    await upload('2001:db8:1:2:bbbb::9');
    const metadata = new Request(`${BASE}/.well-known/oauth-protected-resource/mcp`, { headers: { 'cf-connecting-ip': '2001:db8:1:2:cccc::7' } });
    await app.fetch(metadata, limited);
    expect(keys).toEqual(['2001:db8:1:2::/64', '2001:db8:1:2::/64', '2001:db8:1:2::/64']);
  });

  // 120 a minute for the helper's many small ref and cite uploads; a large body costs one more per full MB.
  it('/facts charges FACTS_RL once per small upload and once more per MB of a large one', async () => {
    let hits = 0;
    let allowed = Infinity;
    const limiter = { limit: async () => ({ success: ++hits <= allowed }) };
    const limited = await testEnv({ FACTS_RL: limiter });
    const upload = (body: string) => app.fetch(new Request(`${BASE}/facts`, { method: 'POST', body }), limited);
    expect((await upload('{"kind":"start"}')).status).toBe(200);
    expect(hits).toBe(1);
    const big = `{"kind":"checkpoint","pad":"${'x'.repeat(2.5 * 1_048_576)}"}`;
    expect((await upload(big)).status).toBe(200);
    expect(hits).toBe(4);
    allowed = hits + 2; // room for the count, not for the size
    expect((await upload(big)).status).toBe(429);
    allowed = Infinity;
    expect((await upload('not a capture')).status).toBe(400);
  });

  it('/facts charges its in-flight budget by the bytes that arrived, and a stalled body gives them back after 30 s', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const stalled = (bytes: Uint8Array) =>
      app.fetch(new Request(`${BASE}/facts`, { method: 'POST', body: new ReadableStream({ start: c => c.enqueue(bytes) }), duplex: 'half' } as RequestInit), env);
    const small = () => app.fetch(new Request(`${BASE}/facts`, { method: 'POST', headers: { 'content-length': '16' }, body: '{"kind":"start"}' }), env);
    const idle = [stalled(new TextEncoder().encode('{')), stalled(new TextEncoder().encode('{'))];
    await new Promise(r => setTimeout(r, 0));
    expect((await small()).status).toBe(200); // two idle sockets hold a byte each, not 8 MB
    const full = stalled(new Uint8Array(MAX_BODY_BYTES - 2)); // with the idle sockets' two bytes: the whole budget
    await new Promise(r => setTimeout(r, 0));
    const busy = await small();
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('5');
    expect((await stalled(new Uint8Array(MAX_BODY_BYTES - 2))).status).toBe(503); // a second full upload waits: the budget is one
    deadline.abort();
    expect((await Promise.all([...idle, full])).map(r => r.status)).toEqual([408, 408, 408]);
    expect(timeout).toHaveBeenCalledWith(30_000);
    timeout.mockRestore();
    expect((await small()).status).toBe(200); // the budget comes back once they end
  });
});

// dev-link: on the local stack the dev agent gets a dashboard link instead of the unreachable owner link.
describe('start_session on the local dev stack', () => {
  afterEach(() => vi.unstubAllGlobals());

  const LOCAL = 'http://localhost:8788';
  const AGENT = identityFromClaims(`${LOCAL}/agent-id`, 'agent:user_dev');
  const PHANTOM = identityFromClaims('', 'user_dev');
  const OTHER = identityFromClaims('', 'someone-real');
  const U64 = { U64: [] };
  const STR = { String: [] };
  const IDENTITY = { Product: { elements: [{ name: { some: '__identity__' }, algebraic_type: { U256: [] } }] } };
  const table = (cols: [string, unknown][], rows: unknown[][]) =>
    JSON.stringify([{ schema: { elements: cols.map(([n, t]) => ({ name: { some: n }, algebraic_type: t })) }, rows }]);

  /** A fake database: records each reducer call; `links` is what my_agent_links answers; `failOffer` makes offer_agent_link fail. */
  function fakeDb(links: { agent: string; owner: string }[], failOffer = false) {
    const calls: { reducer: string; body: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (!path.endsWith('/sql')) {
        const reducer = path.split('/').pop()!;
        calls.push({ reducer, body: String(init?.body ?? '') });
        return failOffer && reducer === 'offer_agent_link' ? new Response('boom', { status: 500 }) : new Response('');
      }
      const q = String(init?.body ?? '');
      if (q.includes('my_board_creations')) return new Response(table([['board_id', U64]], [[7]]));
      if (q.includes('visible_board')) return new Response(table([['id', U64], ['slug', STR], ['name', STR]], [[7, 'abc', 'meeting']]));
      if (q.includes('my_agent_links')) return new Response(table([['agent', IDENTITY], ['owner', IDENTITY]], links.map(l => [[`0x${l.agent}`], [`0x${l.owner}`]])));
      return new Response(table([['id', U64]], []));
    });
    return calls;
  }

  const callStart = async (e: Env, host = LOCAL, userId = 'user_1', clientId = 'client_a') => {
    const a = createApp({ verifyBearer: async () => ({ userId, clientId, via: 'oauth', scopes: ['board:read', 'board:write'] }), ledger: () => ({ charge: async () => ({ ok: true, used: 1 }), claim: async () => ({ first: true }), settle: async () => {} }), captures: memoryCaptures() });
    const res = await a.fetch(
      new Request(`${host}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok_ok', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'start_session', arguments: { name: 'meeting' } } }),
      }),
      e
    );
    const body = await rpcBody(res);
    return body.result.content[0].text as string;
  };
  const devEnv = (over: Partial<Env> = {}) => testEnv({ MCP_ORIGIN: LOCAL, OIDC_ISSUER: '', DEV_AUTH: '1', ...over });
  const offered = (calls: { reducer: string; body: string }[]) => calls.filter(c => c.reducer === 'offer_agent_link');

  it('gate off (no DEV_AUTH): links as today, no dashboard, no offer', async () => {
    const calls = fakeDb([]);
    const text = await callStart(await testEnv({ MCP_ORIGIN: LOCAL, OIDC_ISSUER: 'https://auth.redcrayon.test' }), LOCAL, 'user_dev_link_off');
    expect(calls.map(c => c.reducer)).toContain('link_hosted_agent');
    expect(offered(calls)).toEqual([]);
    expect(JSON.parse(text)).not.toHaveProperty('dashboard');
  });

  // Off localhost auth.ts never mints the dev principal (auth.test.ts covers that), so a real user id is what arrives here.
  it('gate off (DEV_AUTH set but another user id): no dashboard, no offer', async () => {
    const calls = fakeDb([]);
    const e = await devEnv({ MCP_ORIGIN: 'https://mcp.redcrayon.test', OIDC_ISSUER: 'https://auth.redcrayon.test' });
    const text = await callStart(e, 'https://mcp.redcrayon.test');
    expect(offered(calls)).toEqual([]);
    expect(JSON.parse(text)).not.toHaveProperty('dashboard');
  });

  it("gate off (user_dev but clientId is not 'dev'): no dashboard, no offer", async () => {
    const calls = fakeDb([]);
    const text = await callStart(await devEnv({ MCP_ORIGIN: 'https://mcp.redcrayon.test', OIDC_ISSUER: 'https://auth.redcrayon.test' }), 'https://mcp.redcrayon.test', 'user_dev', 'x');
    expect(offered(calls)).toEqual([]);
    expect(JSON.parse(text)).not.toHaveProperty('dashboard');
  });

  it('gate on, not linked: no link_hosted_agent, one offer, dashboard carries the same code', async () => {
    const calls = fakeDb([]);
    const out = JSON.parse(await callStart(await devEnv()));
    expect(calls.map(c => c.reducer)).not.toContain('link_hosted_agent');
    const offers = offered(calls);
    expect(offers).toHaveLength(1);
    const [code] = JSON.parse(offers[0].body) as string[];
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(out.dashboard).toBe(`http://localhost:5174/link?code=${code}`);
    expect(out.dashboardNote).toMatch(/open .*once/i);
    expect(out.url).toBeTruthy();
    expect(out.seat).toMatch(/^[A-Za-z0-9]{16}$/);
  });

  it.each([
    ['the empty-issuer phantom owner', PHANTOM],
    ['a real owner', OTHER],
  ])('gate on, linked to %s: still offers a fresh code', async (_n, owner) => {
    const calls = fakeDb([{ agent: AGENT, owner }]);
    const out = JSON.parse(await callStart(await devEnv()));
    expect(offered(calls)).toHaveLength(1);
    expect(out.dashboard).toMatch(/^http:\/\/localhost:5174\/link\?code=[A-Za-z0-9_-]{43}$/);
  });

  it('the offer failing does not fail start_session', async () => {
    fakeDb([], true);
    const out = JSON.parse(await callStart(await devEnv()));
    expect(out.id).toBe(7);
    expect(out).not.toHaveProperty('dashboard');
  });
});

describe('GET /marks/wait', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const SEAT = 'AbCdEfGhIjKlMnOp';
  const OWNER = () => `${identityFromClaims(`${BASE}/agent-id`, 'agent:user_1')}/${SEAT}`;
  const U64 = { U64: [] };
  const STR = { String: [] };
  const table = (cols: [string, unknown][], rows: unknown[][]) =>
    JSON.stringify([{ schema: { elements: cols.map(([n, t]) => ({ name: { some: n }, algebraic_type: t })) }, rows }]);

  const IDENTITY = { Product: { elements: [{ name: { some: '__identity__' }, algebraic_type: { U256: [] } }] } };
  /** A fake database: claim_marks answers `refuse` (a 530 sentence) or ok; visible_mark answers `marks` from the `after`th read on;
   *  visible_board_people answers `open` ([identity, boards]) and visible_participant the `agents`. */
  function fakeDb(opts: { marks?: [number, string, string][]; after?: number; refuse?: string; down?: boolean; open?: [string, number[]][]; agents?: string[] }) {
    const seen = { claims: [] as string[], queries: [] as string[], tokens: [] as string[], people: [] as string[] };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      seen.tokens.push(String((init?.headers as Record<string, string>).authorization));
      if (opts.down) return new Response('down', { status: 502 });
      if (!path.endsWith('/sql')) {
        seen.claims.push(String(init?.body));
        return opts.refuse ? new Response(opts.refuse, { status: 530 }) : new Response('');
      }
      const query = String(init?.body);
      if (query.includes('visible_board_people')) {
        seen.people.push(query);
        return new Response(table([['identity', IDENTITY], ['board_ids', { Array: U64 }]], (opts.open ?? []).map(([id, boards]) => [[`0x${id}`], boards])));
      }
      if (query.includes('visible_participant')) {
        seen.people.push(query);
        return new Response(table([['identity', IDENTITY], ['kind', STR]], (opts.agents ?? []).map(id => [[`0x${id}`], 'agent'])));
      }
      seen.queries.push(query);
      const rows = seen.queries.length > (opts.after ?? 0) ? opts.marks ?? [] : [];
      return new Response(table([['id', U64], ['node_label', STR], ['note', STR]], rows));
    });
    return seen;
  }
  const wait = (token?: string) => get('/marks/wait', token ? { authorization: `Bearer ${token}` } : {});
  // Token signing runs off the event loop, so a single advance can pass before the next sleep is set: step until it answers.
  async function settle(pending: Promise<Response>): Promise<Response> {
    let done = false;
    void pending.then(() => (done = true));
    while (!done) {
      await vi.advanceTimersByTimeAsync(500);
      await new Promise(r => setImmediate(r));
    }
    return pending;
  }

  it('401 without a marks token: none, a tap token, junk', async () => {
    const seen = fakeDb({});
    for (const token of [undefined, await mintTap(env, 'agent:user_1', 5n), 'junk']) {
      const res = await wait(token);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'invalid_token' });
    }
    expect(seen.claims).toEqual([]);
  });

  it("claims as the token's agent and seat, and returns the seat's claimed marks", async () => {
    const seen = fakeDb({ marks: [[9, 'api', ''], [7, 'db', 'index this']] });
    const res = await wait(await mintMarks(env, 'agent:user_1', 5n, SEAT));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ board: '5', claimed: 2, marks: [{ mark: '7', label: 'db', note: 'index this' }, { mark: '9', label: 'api', note: '' }], people: 0 });
    expect(seen.claims).toEqual([`[5,"${SEAT}"]`]);
    expect(seen.queries[0]).toBe(`SELECT * FROM visible_mark WHERE board_id = 5 AND status = 'claimed' AND claimed_by = '${OWNER()}'`);
    // a database token for the agent, never the marks token itself
    const sub = JSON.parse(atob(seen.tokens[0].slice(7).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    expect(sub).toMatchObject({ sub: 'agent:user_1', iss: `${BASE}/agent-id` });
  });

  it('retries every 10 s and answers claimed 0 when the wait ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const seen = fakeDb({});
    const started = Date.now();
    const res = await settle(wait(await mintMarks(env, 'agent:user_1', 5n, SEAT)));
    expect(Date.now() - started).toBeLessThanOrEqual(MARKS_WAIT_MS);
    expect(await res.json()).toEqual({ board: '5', claimed: 0, people: 0 });
    expect(seen.claims.length).toBeGreaterThanOrEqual(3);
    expect(seen.claims.length).toBeLessThanOrEqual(4);
  });

  it('returns marks claimed on a later try', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const seen = fakeDb({ marks: [[3, 'web', 'why']], after: 2 });
    expect(await (await settle(wait(await mintMarks(env, 'agent:user_1', 5n, SEAT)))).json()).toEqual({ board: '5', claimed: 1, marks: [{ mark: '3', label: 'web', note: 'why' }], people: 0 });
    expect(seen.claims).toHaveLength(3);
  });

  it('people: distinct identities with this board open, not this agent nor any agent, read once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const self = OWNER().split('/')[0];
    const seen = fakeDb({ open: [['aa', [5]], ['aa', [6, 5]], ['bb', [6]], [self, [5]], ['cc', [5]], ['dd', [5]]], agents: ['cc', 'ee'] });
    const res = await settle(wait(await mintMarks(env, 'agent:user_1', 5n, SEAT)));
    expect(await res.json()).toEqual({ board: '5', claimed: 0, people: 2 });
    expect(seen.people).toEqual(['SELECT * FROM visible_board_people', "SELECT * FROM visible_participant WHERE kind = 'agent'"]);
  });

  it('people: skips the participant read when only this agent has the board open', async () => {
    const seen = fakeDb({ marks: [[1, 'api', '']], open: [[OWNER().split('/')[0], [5]]] });
    expect(await (await wait(await mintMarks(env, 'agent:user_1', 5n, SEAT))).json()).toMatchObject({ claimed: 1, people: 0 });
    expect(seen.people).toEqual(['SELECT * FROM visible_board_people']);
  });

  it("403 with the module's sentence when it refuses the claim", async () => {
    fakeDb({ refuse: 'not authorized: board is read only' });
    const res = await wait(await mintMarks(env, 'agent:user_1', 5n, SEAT));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', error_description: 'REJECTED: not authorized: board is read only' });
  });

  it('500 with a ref when the database is down, so the helper backs off', async () => {
    fakeDb({ down: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await wait(await mintMarks(env, 'agent:user_1', 5n, SEAT));
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error).toBe('internal_error');
  });
});

describe('POST /hooks/alert', () => {
  afterEach(() => vi.unstubAllGlobals());

  const U64 = { U64: [] };
  const STR = { String: [] };
  const table = (cols: [string, unknown][], rows: unknown[][]) =>
    JSON.stringify([{ schema: { elements: cols.map(([n, t]) => ({ name: { some: n }, algebraic_type: t })) }, rows }]);
  /** A fake database: visible_board knows slug abc as board 5; my_incidents answers `incidents` ([boardId, slug, groupKey, status]). */
  function fakeDb(opts: { incidents?: [number, string, string, string][]; refuse?: string }) {
    const seen = { calls: [] as string[], queries: [] as string[] };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (!path.endsWith('/sql')) {
        seen.calls.push(`${path.split('/').pop()} ${String(init?.body)}`);
        return opts.refuse ? new Response(opts.refuse, { status: 530 }) : new Response('');
      }
      const query = String(init?.body);
      seen.queries.push(query);
      if (query.includes('visible_board')) return new Response(table([['id', U64]], query.includes("'abc'") ? [[5]] : []));
      return new Response(table([['board_id', U64], ['slug', STR], ['group_key', STR], ['status', STR]], opts.incidents ?? []));
    });
    return seen;
  }
  const ALERT = { version: '4', groupKey: '{}:{alertname="HighLatency"}', status: 'firing', commonLabels: { alertname: 'HighLatency' }, alerts: [{ startsAt: '2026-10-31T14:32:00Z' }, { startsAt: '2026-10-31T14:30:00Z' }] };
  const post = (body: unknown, headers: Record<string, string> = { authorization: 'Bearer tok_ok' }, board = 'abc') =>
    app.fetch(new Request(`${BASE}/hooks/alert?board=${board}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }), env);

  it('401 without a token, 403 from a browser or without board:write', async () => {
    const seen = fakeDb({});
    expect((await post(ALERT, {})).status).toBe(401);
    expect((await post(ALERT, { authorization: 'Bearer tok_ok', origin: 'https://evil.test' })).status).toBe(403);
    expect((await post(ALERT, { authorization: 'Bearer tok_read' })).status).toBe(403);
    expect(seen.calls).toEqual([]);
  });

  it('400 for a body that is not an alert', async () => {
    const seen = fakeDb({});
    expect((await post('not json')).status).toBe(400);
    expect((await post({ status: 'firing' })).status).toBe(400);
    expect((await post({ groupKey: 'g', status: 'pending' })).status).toBe(400);
    expect(seen.calls).toEqual([]);
  });

  it('opens the incident as the caller and answers with its link', async () => {
    const seen = fakeDb({ incidents: [[8, 'old', ALERT.groupKey, 'resolved'], [9, 'new9', ALERT.groupKey, 'firing'], [10, 'other', 'g2', 'firing']] });
    const res = await post(ALERT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'firing', board: 'new9', url: 'https://app.redcrayon.test/#b=new9' });
    expect(seen.calls).toEqual([`open_incident [5,${JSON.stringify(ALERT.groupKey)},"Incident: HighLatency","firing",${Date.parse('2026-10-31T14:30:00Z')}]`]);
    expect(seen.queries[1]).toBe('SELECT * FROM my_incidents WHERE source_board_id = 5');
  });

  it('a resolved alert with nothing open answers board null; an unknown board 404s', async () => {
    fakeDb({});
    expect(await (await post({ ...ALERT, status: 'resolved' })).json()).toEqual({ status: 'resolved', board: null });
    expect((await post(ALERT, undefined, 'zzz')).status).toBe(404);
  });

  it("passes a module refusal through as 403 with the rule's sentence", async () => {
    fakeDb({ refuse: 'not authorized: board is read only' });
    const res = await post(ALERT);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error_description).toMatch(/board is read only/);
  });
});
