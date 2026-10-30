import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbLoad, judge, resetDemo, scheduled, type CanaryEnv } from './canary';

describe('the outcome check', () => {
  it('alerts on an error ratio above 5% over 5 min', () => {
    expect(judge([{ outcome: 'ok', status: 200, n: 90 }, { outcome: 'unavailable', status: 503, n: 10 }], [])).toEqual(['error ratio 10% over 5 min (10 of 100)']);
    expect(judge([{ outcome: 'ok', status: 200, n: 96 }, { outcome: 'unconfirmed', status: 200, n: 4 }], [])).toEqual([]);
  });

  it('alerts on any 402, and on a 400 lasting more than 5 min', () => {
    expect(judge([{ outcome: 'ok', status: 200, n: 1000 }, { outcome: 'unavailable', status: 402, n: 1 }], [])).toContain('the database answered 402 (out of budget)');
    const fourHundred = [{ outcome: 'ok', status: 200, n: 1000 }, { outcome: 'unavailable', status: 400, n: 1 }];
    expect(judge(fourHundred, [])).toEqual([]);
    expect(judge(fourHundred, fourHundred)).toEqual(['the database has answered 400 for more than 5 min']);
  });

  it('module refusals are not errors', () => {
    expect(judge([{ outcome: 'rejected', status: 530, n: 50 }, { outcome: 'ok', status: 200, n: 1 }], [])).toEqual([]);
  });
});

describe('the cron', () => {
  afterEach(() => vi.unstubAllGlobals());
  const env = { MCP_ORIGIN: 'https://mcp.example.com', CANARY_API_KEY: 'ak', ALERT_WEBHOOK: 'https://hooks.example.com/x' } as CanaryEnv;

  it('posts one alert line when the canary fails, and the recovery on the next good run', async () => {
    const posted: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => (posted.push(JSON.parse(String(init.body)).text), new Response('ok'))));
    let failing = false;
    const state = { get: async () => failing, set: async (v: boolean) => void (failing = v) };
    const down = async () => new Response('nope', { status: 503 });
    await scheduled(down, env, state);
    expect(posted).toEqual(['redcrayon mcp (mcp.example.com): canary failed: start_session: HTTP 503 nope']);
    expect(failing).toBe(true);

    const answers: Record<string, string> = {
      start_session: '{"id":7}',
      get_board: '{"nodes":[{"id":"3","label":"canary","x":8}]}',
      move_node: 'committed board=_canary',
    };
    const up = async (req: Request) => {
      const { params } = (await req.json()) as { params: { name: string } };
      return new Response(JSON.stringify({ result: { content: [{ text: answers[params.name] }] } }));
    };
    await scheduled(up, env, state);
    expect(posted.at(-1)).toBe('redcrayon mcp (mcp.example.com): recovered');
    expect(failing).toBe(false);
  });

  it('logs demo.reset only after a reset, and alerts when reset_demo fails', async () => {
    const posted: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => (posted.push(JSON.parse(String(init.body)).text), new Response('ok'))));
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(line => void logs.push(String(line)));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = { get: async () => false, set: async () => {} };
    const answers: Record<string, string> = { start_session: '{"id":7}', get_board: '{"nodes":[{"id":"3","label":"canary","x":8}]}', move_node: 'committed' };
    const up = async (req: Request) => {
      const { params } = (await req.json()) as { params: { name: string } };
      return new Response(JSON.stringify({ result: { content: [{ text: answers[params.name] }] } }));
    };

    await scheduled(up, env, state, async () => false);
    expect(logs).toEqual(['{"event":"canary.ok"}']);
    await scheduled(up, env, state, async () => true);
    expect(logs.slice(1)).toEqual(['{"event":"demo.reset"}', '{"event":"canary.ok"}']);
    expect(posted).toEqual([]);
    await scheduled(up, env, state, async () => { throw new Error('the database answered 503'); });
    expect(posted).toEqual(['redcrayon mcp (mcp.example.com): demo reset failed: the database answered 503']);
    vi.restoreAllMocks();
  });
});

describe('the Demo reset', () => {
  const at = (micros: bigint) => [{ boardId: 3n, resetAt: { microsSinceUnixEpoch: micros } }];

  it('calls reset_demo and reports whether Demo was reset', async () => {
    for (const [before, after, reset] of [[[], at(5n), true], [at(5n), at(5n), false], [at(5n), at(9n), true], [[], [], false]] as const) {
      const reads = [before, after];
      const db = { read: vi.fn(async (_query: unknown) => reads.shift() as never[]), call: vi.fn(async () => {}) };
      expect(await resetDemo(db)).toBe(reset);
      expect(db.call).toHaveBeenCalledExactlyOnceWith('reset_demo', {});
      expect(db.read.mock.calls[0][0]).toEqual({ text: 'SELECT * FROM service_demo_reset' });
    }
  });
});

describe('the database load', () => {
  afterEach(() => (vi.restoreAllMocks(), vi.unstubAllGlobals()));
  const now = Date.UTC(2026, 9, 21, 12);
  const at = (msAgo: number) => ({ microsSinceUnixEpoch: BigInt(now - msAgo) * 1000n });
  const rows = [
    { kind: 'human', connections: 2, lastSeenAt: at(0) },
    { kind: 'human', connections: 0, lastSeenAt: at(0) },
    { kind: 'agent', connections: 0, lastSeenAt: at(60_000) },
    { kind: 'agent', connections: 0, lastSeenAt: at(2 * 3_600_000) },
  ];
  const read = async <T>() => rows as T[];
  const otlp = { DB_NAME: 'redcrayon', SERVICE_NAME: 'redcrayon-mcp-staging', OTLP_METRICS_URL: 'https://otlp.example.com/otlp/v1/metrics', OTLP_METRICS_AUTH: 'Basic c2VjcmV0' };

  it('logs participants, online senders, connections and agents seen this hour, and pushes no metrics without OTLP settings', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const queries: string[] = [];
    await dbLoad({ read: async <T>(q: { text: string }) => (queries.push(q.text), rows as T[]) }, { DB_NAME: 'redcrayon', OTLP_METRICS_URL: otlp.OTLP_METRICS_URL }, now);
    expect(queries).toEqual(['SELECT kind, connections, last_seen_at FROM visible_participant']);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ event: 'db.load', db: 'redcrayon', participants: 4, online: 1, connections: 2, agents: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('pushes one OTLP/HTTP JSON gauge per count, labelled with the database', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await dbLoad({ read }, otlp, now);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://otlp.example.com/otlp/v1/metrics');
    expect(init.headers).toEqual({ authorization: 'Basic c2VjcmV0', 'content-type': 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const [resource] = JSON.parse(String(init.body)).resourceMetrics;
    expect(resource.resource.attributes).toEqual([{ key: 'service.name', value: { stringValue: 'redcrayon-mcp-staging' } }]);
    const point = { attributes: [{ key: 'db', value: { stringValue: 'redcrayon' } }], timeUnixNano: `${now}000000` };
    expect(resource.scopeMetrics[0].metrics).toEqual([
      { name: 'db.participants', gauge: { dataPoints: [{ ...point, asInt: '4' }] } },
      { name: 'db.online', gauge: { dataPoints: [{ ...point, asInt: '1' }] } },
      { name: 'db.connections', gauge: { dataPoints: [{ ...point, asInt: '2' }] } },
      { name: 'db.agents', gauge: { dataPoints: [{ ...point, asInt: '1' }] } },
    ]);
  });

  it('a refused push is one error line without the auth value, and does not throw', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('authentication error: invalid token', { status: 401 })));
    await dbLoad({ read }, otlp, now);
    expect(error.mock.calls.map(c => JSON.parse(c[0]))).toEqual([{ event: 'metrics.push_failed', db: 'redcrayon', error: 'Error: HTTP 401 authentication error: invalid token' }]);
    expect(JSON.stringify(error.mock.calls)).not.toContain('c2VjcmV0');
  });

  it('a failed read logs one error line, pushes nothing, and does not throw', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await dbLoad({ read: async () => Promise.reject(new Error('the database answered 503 to sql: down')) }, otlp, now);
    expect(JSON.parse(error.mock.calls[0][0])).toEqual({ event: 'db.load_failed', db: 'redcrayon', error: 'Error: the database answered 503 to sql: down' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
