/**
 * The cron every 5 minutes (spec §10, RC-556): (a) the canary runs a real
 * session through the Worker's own fetch handler with the canary's service
 * API key (start_session on `_canary`, get_board, move_node), and (b) an
 * Analytics Engine check looks at the last minutes of tools/call outcomes.
 * Any failure POSTs one line to ALERT_WEBHOOK; a recovery is logged. The same
 * cron keeps Demo tidy (RC-568, resetDemo below), and once an hour it logs the
 * database load (dbLoad, RC-549).
 */
import { sql, type Database } from './db';
import type { Env } from './env';

export type Fetch = (request: Request) => Promise<Response>;

export interface CanaryEnv extends Env {
  CANARY_API_KEY?: string;
  ALERT_WEBHOOK?: string;
  ANALYTICS_ACCOUNT?: string;
  CF_ANALYTICS_TOKEN?: string;
  /** rc_calls or rc_calls_staging */
  CALLS_DATASET?: string;
  /** the Worker's name, as its traces and logs carry it in service_name (OTLP service.name) */
  SERVICE_NAME?: string;
  /** full OTLP/HTTP metrics URL, e.g. <gateway>/otlp/v1/metrics; with OTLP_METRICS_AUTH, the hourly load is pushed there */
  OTLP_METRICS_URL?: string;
  /** the whole Authorization header value, e.g. `Basic <base64 instance:token>`; never logged */
  OTLP_METRICS_AUTH?: string;
}

/** One tools/call over the 2025-era stateless path; the answer is one SSE message event or JSON. */
async function callTool(fetch: Fetch, env: CanaryEnv, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const res = await fetch(
    new Request(`${env.MCP_ORIGIN.replace(/\/$/, '')}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CANARY_API_KEY}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${text.slice(0, 200)}`);
  const data = text.startsWith('event:') ? text.split('\n').find(l => l.startsWith('data: '))?.slice(6) ?? '' : text;
  const body = JSON.parse(data) as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } };
  if (!body.result) throw new Error(`${name}: ${body.error?.message ?? 'no result'}`);
  return { text: body.result.content[0]?.text ?? '', isError: body.result.isError === true };
}

/** The canary session. Throws with the first step that failed. */
export async function canary(fetch: Fetch, env: CanaryEnv): Promise<void> {
  if (!env.CANARY_API_KEY) throw new Error('CANARY_API_KEY is not set');
  const step = async (name: string, args: Record<string, unknown>) => {
    const r = await callTool(fetch, env, name, args);
    if (r.isError) throw new Error(`${name}: ${r.text}`);
    return r.text;
  };
  const board = String(JSON.parse(await step('start_session', { name: '_canary' })).id);
  const snap = JSON.parse(await step('get_board', { board })) as { nodes: { id: string; label: string; x: number }[] };
  let node = snap.nodes.find(n => n.label === 'canary');
  if (!node) {
    const made = await step('create_node', { board, label: 'canary', sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'muted', focal: false });
    // The write can land while the id read fails ("committed (no new row observed…)").
    // Name that text: an empty id would alert with move_node's refusal instead.
    const id = /committed id=(\d+)/.exec(made)?.[1];
    if (!id) throw new Error(`create_node committed but named no id: ${made}`);
    node = { id, label: 'canary', x: 0 };
  }
  await step('move_node', { board, nodeId: node.id, x: node.x === 0 ? 8 : 0, y: 0 });
}

type Row = { outcome: string; status: number; n: number };

async function analytics(env: CanaryEnv, sql: string): Promise<Row[]> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ANALYTICS_ACCOUNT}/analytics_engine/sql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
    body: sql,
  });
  if (!res.ok) throw new Error(`analytics query: HTTP ${res.status}`);
  return ((await res.json()) as { data: Row[] }).data.map(r => ({ outcome: r.outcome, status: Number(r.status), n: Number(r.n) }));
}

/** Alert reasons from the outcomes of the last 5 minutes (and the 5 before, for a lasting 400). */
export function judge(last: Row[], before: Row[]): string[] {
  const total = last.reduce((s, r) => s + r.n, 0);
  const failed = last.filter(r => r.outcome === 'unavailable' || r.outcome === 'unconfirmed').reduce((s, r) => s + r.n, 0);
  const reasons: string[] = [];
  if (total > 0 && failed / total > 0.05) reasons.push(`error ratio ${Math.round((failed / total) * 100)}% over 5 min (${failed} of ${total})`);
  if (last.some(r => r.status === 402)) reasons.push('the database answered 402 (out of budget)');
  if (last.some(r => r.status === 400) && before.some(r => r.status === 400)) reasons.push('the database has answered 400 for more than 5 min');
  return reasons;
}

async function outcomes(env: CanaryEnv): Promise<string[]> {
  if (!env.ANALYTICS_ACCOUNT || !env.CF_ANALYTICS_TOKEN) return [];
  const dataset = env.CALLS_DATASET ?? 'rc_calls';
  const q = (from: number, to: number) =>
    `SELECT blob2 AS outcome, double5 AS status, SUM(_sample_interval) AS n FROM ${dataset} ` +
    `WHERE timestamp > NOW() - INTERVAL '${from}' MINUTE AND timestamp <= NOW() - INTERVAL '${to}' MINUTE GROUP BY outcome, status`;
  return judge(await analytics(env, q(5, 0)), await analytics(env, q(10, 5)));
}

export async function alert(env: CanaryEnv, text: string): Promise<void> {
  console.error(JSON.stringify({ event: 'canary.alert', alert: text }));
  if (env.ALERT_WEBHOOK) await fetch(env.ALERT_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
}

/**
 * reset_demo as the Worker's service identity: the module puts Demo back to its seed once nobody wrote to
 * it for 10 minutes, and leaves an unchanged one alone. True when it reset (Demo's resetAt moved).
 */
export async function resetDemo(db: Pick<Database, 'read' | 'call'>): Promise<boolean> {
  const resetAt = async () =>
    String((await db.read<{ resetAt: { microsSinceUnixEpoch: bigint } }>(sql`SELECT * FROM service_demo_reset`))[0]?.resetAt.microsSinceUnixEpoch ?? '');
  const before = await resetAt();
  await db.call('reset_demo', {});
  return (await resetAt()) !== before;
}

/** The cron: canary, Demo's reset, then the outcome check; `state` remembers whether the last run failed, to log the recovery. */
export async function scheduled(fetch: Fetch, env: CanaryEnv, state: { get(): Promise<boolean>; set(failing: boolean): Promise<void> }, demo?: () => Promise<boolean>) {
  const problems: string[] = [];
  try {
    await canary(fetch, env);
  } catch (err) {
    problems.push(`canary failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (demo) {
    try {
      // Not idle or unchanged is the usual answer, and says nothing.
      if (await demo()) console.log(JSON.stringify({ event: 'demo.reset' }));
    } catch (err) {
      problems.push(`demo reset failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    problems.push(...(await outcomes(env)));
  } catch (err) {
    problems.push(`outcome check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const wasFailing = await state.get();
  if (problems.length > 0) {
    await alert(env, `redcrayon mcp (${new URL(env.MCP_ORIGIN).host}): ${problems.join('; ')}`);
    await state.set(true);
  } else {
    console.log(JSON.stringify({ event: wasFailing ? 'canary.recovered' : 'canary.ok' }));
    if (wasFailing) {
      await alert(env, `redcrayon mcp (${new URL(env.MCP_ORIGIN).host}): recovered`);
      await state.set(false);
    }
  }
}

type Participant = { kind: string; connections: number; lastSeenAt: { microsSinceUnixEpoch: bigint } };
type Counts = { participants: number; online: number; connections: number; agents: number };
type LoadEnv = Pick<CanaryEnv, 'DB_NAME' | 'SERVICE_NAME' | 'OTLP_METRICS_URL' | 'OTLP_METRICS_AUTH'>;

const message = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : String(err));

/**
 * RC-549: the database bills energy, but no API reports it,
 * so log what drives it: senders whose views re-run. Counts only, never an identity or a name.
 * Also pushed as OTLP gauges when OTLP_METRICS_URL and OTLP_METRICS_AUTH are set.
 * A failure is one error line, never an alert.
 */
export async function dbLoad(db: Pick<Database, 'read'>, env: LoadEnv, now = Date.now()): Promise<void> {
  let counts: Counts;
  try {
    const rows = await db.read<Participant>(sql`SELECT kind, connections, last_seen_at FROM visible_participant`);
    const hourAgo = BigInt(now - 3_600_000) * 1000n;
    counts = {
      participants: rows.length,
      online: rows.filter(r => r.connections > 0).length,
      connections: rows.reduce((s, r) => s + r.connections, 0),
      agents: rows.filter(r => r.kind === 'agent' && r.lastSeenAt.microsSinceUnixEpoch > hourAgo).length,
    };
  } catch (err) {
    console.error(JSON.stringify({ event: 'db.load_failed', db: env.DB_NAME, error: message(err) }));
    return;
  }
  console.log(JSON.stringify({ event: 'db.load', db: env.DB_NAME, ...counts }));
  if (!env.OTLP_METRICS_URL || !env.OTLP_METRICS_AUTH) return;
  try {
    const res = await fetch(env.OTLP_METRICS_URL, {
      method: 'POST',
      headers: { authorization: env.OTLP_METRICS_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(otlpGauges(env.SERVICE_NAME ?? 'redcrayon-mcp', env.DB_NAME, counts, now)),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    console.error(JSON.stringify({ event: 'metrics.push_failed', db: env.DB_NAME, error: message(err) }));
  }
}

/** One OTLP/HTTP JSON request: a gauge `db.<count>` per count, labelled with the database. No SDK: it is four numbers. */
export function otlpGauges(service: string, db: string, counts: Counts, now: number) {
  const point = { attributes: [{ key: 'db', value: { stringValue: db } }], timeUnixNano: String(BigInt(now) * 1_000_000n) };
  return {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeMetrics: [
          {
            scope: { name: 'redcrayon-mcp/cron' },
            metrics: Object.entries(counts).map(([name, n]) => ({ name: `db.${name}`, gauge: { dataPoints: [{ ...point, asInt: String(n) }] } })),
          },
        ],
      },
    ],
  };
}
