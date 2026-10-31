/**
 * The mcp Worker's HTTP surface (spec §1 Routes, CORS; §2 Auth; §10 limits).
 * Runtime-free: worker.ts passes the token verifiers to createWorker, which
 * wires the USER and CAPTURE Durable Objects and the cron; tests pass fakes to
 * createApp. The Worker answers only on its own host.
 */
import { createMcpHandler } from '@modelcontextprotocol/server';
import { authenticate, isManagedBearer, managedApiKeys, selfHostedUsers, userInfo, type ManagedKey, type Principal, type UserLookup, type VerifyBearer } from './auth';
import { dbLoad, resetDemo, scheduled, type CanaryEnv } from './canary';
import { MISSING_SCOPE, NO_TOKEN, SIGN_IN_ENDED, TOO_LARGE, newRef, ruleViolation, tooMany } from './copy';
import { database, safeToken, safeU64, sql, type Database, type SafeU64 } from './db';
import { origins, version, type AnalyticsEngineDataset, type Env, type Origins } from './env';
import { SERVICE_SUBJECT, principalSubject, discovery, jwks, mint, verifyMarks } from './issuer';
import { isModuleSentence } from './scrub';
import { DbError } from '../../shared/db-http';
import { identityFromClaims } from '../../shared/identity';
import { TOOLS, createServer, type CallContext, type Ledger, type LogLine, type Quota } from './tools';
import { FACTS_TOO_LARGE, storeUpload, type CaptureStub } from './captures';
import { MAX_BODY_BYTES, MB } from '../../shared/capture';
import { errorKind } from './scrub';

export type Deps = {
  verifyBearer: VerifyBearer;
  /** names and plans; default: a user is named by its id, on the self-hosted plan */
  users?: UserLookup;
  /** asked before every tool call; default: always allow */
  quota?: Quota;
  ledger: (userId: string) => Ledger;
  /** the CAPTURE Durable Object for one capture id */
  captures: (id: string) => CaptureStub;
  /** the identity provider's authorization-server metadata, fetched for 2025-03-26-era clients */
  fetchMetadata?: (url: string) => Promise<Response>;
  /** Workers custom spans (cloudflare:workers); absent under Node tests */
  tracing?: Pick<Tracing, 'enterSpan'>;
};

export const MAX_BODY = 256 * 1024;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const notFound = () => json(404, { error: 'not_found' });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-expose-headers': 'WWW-Authenticate, Mcp-Session-Id',
};

/** No Origin, or any https origin; http://localhost:* only in local dev. Anything else is refused (spec §1 CORS). */
function originAllowed(env: Env, request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  // With DEV_AUTH every localhost request is user_dev, so a web page must not reach it: localhost origins only.
  if (env.DEV_AUTH === '1') return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return /^https:\/\/[^/]+$/.test(origin);
}

const withCors = (res: Response) => {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
};

const challenge = (o: Origins) => `Bearer resource_metadata="${o.resourceMetadata}", scope="board:read board:write"`;

// Anthropic's egress range: every claude.ai user arrives from it, so it gets a larger IP allowance.
function inAnthropicRange(ip: string): boolean {
  const m = /^160\.79\.(\d+)\.\d+$/.exec(ip);
  return m !== null && Number(m[1]) >= 104 && Number(m[1]) <= 111;
}

/** The rate-limit key for an address: IPv4 as it is, IPv6 by its /64 (one host holds a whole /64). */
export function ipKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

async function ipLimited(env: Env, request: Request): Promise<boolean> {
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  const limiter = inAnthropicRange(ip) ? env.ANTHROPIC_RL : env.IP_RL;
  return limiter !== undefined && !(await limiter.limit({ key: ipKey(ip) })).success;
}

/**
 * The body, at most `max` bytes, counted as it streams: a chunked upload has no
 * Content-Length to check first. undefined when it is over, when `spend` refuses
 * a chunk, or when `signal` aborts before the body ends.
 */
export async function readCapped(request: Request, max: number, spend = (_bytes: number) => true, signal?: AbortSignal): Promise<Uint8Array | undefined> {
  if (Number(request.headers.get('content-length') ?? 0) > max) return undefined;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const stop = () => void reader.cancel();
  signal?.addEventListener('abort', stop);
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) return undefined;
      if (done) break;
      size += value.byteLength;
      if (size > max || !spend(value.byteLength)) {
        await reader.cancel();
        return undefined;
      }
      parts.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', stop);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const TOO_MANY = () => json(429, { error: 'too_many_requests', error_description: tooMany(60) }, { 'retry-after': '60' });

/** The tools a JSON-RPC body calls, for the scope check before the MCP handler runs. */
function calledTools(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap(m =>
    m && typeof m === 'object' && (m as { method?: unknown }).method === 'tools/call' ? [String((m as { params?: { name?: unknown } }).params?.name ?? '')] : []
  );
}

let metadataCache: { body: string; until: number } | undefined;
let healthCache: { status: number; body: unknown; until: number } | undefined;
let warm = false;
// shortcut: per-isolate budget of one full upload, charged as bytes arrive. A sealed upload then holds up to ~6x its
// size (request bytes, decoded string, the plaintext copy and ciphertext sealCapture makes, the base64 string, the
// store's RPC copy; measured on 8 MB in Node: 4.7x steady, 5.8x at the worst instant, 68 MB peak RSS), so one is
// ~50 MB of the 128 MB isolate and a burst cannot reset it under other callers; two would be ~100 MB.
// Upgrade to a streaming store (no copies) if real uploads wait on it.
const FACTS_BUDGET = MAX_BODY_BYTES;
let factsBytes = 0;
// the helper gives up after 30 s too; a stalled body gives its share of the budget back
const FACTS_READ_MS = 30_000;

const LIVE_PATH = /^\/live\/(\d{1,20})$/;

/**
 * /live/<board>: the board's live tap channel. The socket authenticates with
 * its first message inside the Durable Object (browsers cannot set headers on
 * a WebSocket, and a token in the URL or subprotocol would reach request logs).
 */
async function live(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json(426, { error: 'upgrade_required' }, { upgrade: 'websocket' });
  if (!env.LIVE) return json(503, { error: 'live_unavailable' });
  if (await ipLimited(env, request)) return TOO_MANY();
  const board = LIVE_PATH.exec(url.pathname)![1];
  const headers = new Headers(request.headers);
  headers.set('x-live-board', board);
  return env.LIVE.get(env.LIVE.idFromName(board)).fetch(url.toString(), { headers });
}

// One /marks/wait request claims for at most ~25 s: each DB request has its own 5 s cap, and the helper simply asks again.
export const MARKS_WAIT_MS = 25_000;
export const MARKS_RETRY_MS = 10_000;

/**
 * GET /marks/wait: the helper's `marks` command (spec 2026-10-19 D18). The
 * watch_marks token rides in Authorization, never the URL (request logs). Claims
 * as the token's agent and seat, like wait_for_marks, until a mark is claimed or
 * the wait ends; the agent then calls wait_for_marks to read them in full.
 */
async function marksWait(request: Request, env: Env, o: Origins): Promise<Response> {
  const auth = request.headers.get('authorization') ?? '';
  const claims = auth.startsWith('Bearer ') ? await verifyMarks(env, auth.slice(7)) : null;
  const board = claims && safeU64(claims.board);
  if (!claims || !board) return json(401, { error: 'invalid_token' });
  const db = database(env, () => mint(env, claims.sub));
  const owner = safeToken(identityFromClaims(o.issuer, claims.sub))!;
  const seat = safeToken(claims.seat)!;
  const until = Date.now() + MARKS_WAIT_MS;
  try {
    for (;;) {
      await db.call('claim_marks', { boardId: board, seat });
      const rows = await db.read<Record<string, any>>(sql`SELECT * FROM visible_mark WHERE board_id = ${board} AND status = 'claimed' AND claimed_by = '${owner}/${seat}'`);
      if (rows.length > 0) {
        const marks = rows.sort((x, y) => (x.id < y.id ? -1 : 1)).map(m => ({ mark: String(m.id), label: m.nodeLabel, note: m.note }));
        return json(200, { board: String(board), claimed: rows.length, marks, people: await peopleOn(db, board, owner) });
      }
      if (Date.now() + MARKS_RETRY_MS >= until) return json(200, { board: String(board), claimed: 0, people: await peopleOn(db, board, owner) });
      await new Promise(r => setTimeout(r, MARKS_RETRY_MS));
    }
  } catch (err) {
    // The module refused (e.g. the agent lost write access): its own sentence. Anything else is a 500 the helper retries.
    if (err instanceof DbError && err.status === 530 && isModuleSentence(err.message)) return json(403, { error: 'forbidden', error_description: ruleViolation(err.message, undefined) });
    throw err;
  }
}

/** Distinct people with the board open, not counting this agent or any other agent: the helper stops watching once nobody has it open. */
async function peopleOn(db: Database, board: SafeU64, self: string): Promise<number> {
  const open = await db.read<{ identity: string; boardIds: bigint[] }>(sql`SELECT * FROM visible_board_people`);
  const ids = new Set(open.filter(r => r.boardIds.includes(board)).map(r => r.identity));
  ids.delete(self);
  if (ids.size === 0) return 0;
  for (const p of await db.read<{ identity: string }>(sql`SELECT * FROM visible_participant WHERE kind = 'agent'`)) ids.delete(p.identity);
  return ids.size;
}

export function createApp(deps: Deps) {
  // One handler per isolate; every request builds its own server from the context in authInfo.extra.
  const mcp = createMcpHandler(({ authInfo }) => createServer((authInfo!.extra as { call: CallContext }).call), {
    legacy: 'stateless',
    responseMode: 'json',
  });

  async function handleMcp(request: Request, env: Env, o: Origins, cold: boolean): Promise<Response> {
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
    const body = await readCapped(request, MAX_BODY);
    if (!body) return json(413, { error: 'request_too_large', error_description: TOO_LARGE });

    const hasToken = request.headers.has('authorization');
    // The IP limit is spent on every request the verifier would have to answer: none, or a token not yet cached.
    const verdict = await authenticate(env, request, deps.verifyBearer, Date.now(), () => ipLimited(env, request));
    if (!verdict.ok) {
      if (verdict.status === 429) return TOO_MANY();
      if (verdict.status === 503) return json(503, { error: 'temporarily_unavailable' }, { 'retry-after': '30' });
      return json(401, { error: 'invalid_token', error_description: hasToken ? SIGN_IN_ENDED : NO_TOKEN }, { 'www-authenticate': challenge(o) });
    }
    const principal = verdict.principal;

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      parsed = undefined; // the MCP handler answers malformed JSON itself
    }
    for (const name of calledTools(parsed)) {
      const scope = TOOLS[name]?.scope;
      if (scope && !principal.scopes.includes(scope)) {
        return json(403, { error: 'insufficient_scope', error_description: MISSING_SCOPE }, { 'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}"` });
      }
    }

    const call = callContext(env, o, principal, deps, cold);
    return mcp.fetch(new Request(request, { body }), {
      authInfo: { token: 'redacted', clientId: principal.clientId, scopes: principal.scopes, extra: { call } },
      parsedBody: parsed,
    });
  }

  async function health(env: Env): Promise<Response> {
    const now = Date.now();
    if (!healthCache || now >= healthCache.until) {
      const db = database(env, () => mint(env, SERVICE_SUBJECT));
      const started = Date.now();
      try {
        await db.read(sql`SELECT * FROM my_boards`);
        healthCache = { status: 200, body: { status: 'ok', version: version(env), db: 'ok', dbMs: Date.now() - started }, until: now + 10_000 };
      } catch {
        healthCache = { status: 503, body: { status: 'degraded', db: 'unreachable' }, until: now + 10_000 };
      }
    }
    return json(healthCache.status, healthCache.body, { 'cache-control': 'no-store' });
  }

  async function authServerMetadata(env: Env, o: Origins): Promise<Response> {
    const now = Date.now();
    if (!metadataCache || now >= metadataCache.until) {
      const res = await (deps.fetchMetadata ?? fetch)(`${o.idp.replace(/\/$/, '')}/.well-known/oauth-authorization-server`);
      if (!res.ok) return json(503, { error: 'temporarily_unavailable' }, { 'retry-after': '30' });
      metadataCache = { body: await res.text(), until: now + 3600_000 };
    }
    return new Response(metadataCache.body, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' } });
  }

  /**
   * The helper's upload (spec §5): no auth (write-only; a capture binds to a
   * user only when a signed-in call claims it), no browser (any Origin is
   * refused), 120 a minute per IP (the helper uploads once per cited edge and
   * code ref), 8 MB at most, and each full MB costs one more of the 120.
   */
  async function facts(request: Request, env: Env): Promise<Response> {
    if (request.headers.has('origin')) return json(403, { error: 'forbidden_origin' });
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
    // ipKey, as every other limit: one IPv6 host owns a whole /64 and could pick a fresh address per upload.
    const ip = ipKey(request.headers.get('cf-connecting-ip') ?? '');
    if (env.FACTS_RL && !(await env.FACTS_RL.limit({ key: ip })).success) return TOO_MANY();
    let held = 0;
    let busy = false;
    const spend = (bytes: number) => {
      busy = factsBytes + bytes > FACTS_BUDGET;
      if (busy) return false;
      factsBytes += bytes;
      held += bytes;
      return true;
    };
    const deadline = AbortSignal.timeout(FACTS_READ_MS);
    try {
      const bytes = await readCapped(request, MAX_BODY_BYTES, spend, deadline);
      if (busy) return json(503, { error: 'temporarily_unavailable' }, { 'retry-after': '5' });
      if (!bytes && deadline.aborted) return json(408, { error: 'request_timeout' });
      if (!bytes) return json(413, { error: 'request_too_large', error_description: FACTS_TOO_LARGE });
      // Small uploads (start, ref, cite) cost one; large ones are held to about 13 full 8 MB bodies a minute.
      for (let n = MB; n <= bytes.length; n += MB) if (env.FACTS_RL && !(await env.FACTS_RL.limit({ key: ip })).success) return TOO_MANY();
      const { status, json: body } = await storeUpload(new TextDecoder().decode(bytes), deps.captures);
      return json(status, body);
    } finally {
      factsBytes -= held;
    }
  }

  async function route(request: Request, env: Env, cold: boolean): Promise<Response> {
    const url = new URL(request.url);
    const o = origins(env);
    if (url.host !== o.host) return notFound();
    const path = url.pathname;
    if (path === '/facts') return facts(request, env);
    const known = path === '/mcp' || path === '/marks/wait' || path.startsWith('/.well-known/') || path.startsWith('/agent-id/') || path === '/health';
    if (!known) return notFound();
    if (!originAllowed(env, request)) return json(403, { error: 'forbidden_origin' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

    if (path === '/mcp') return handleMcp(request, env, o, cold);
    if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { allow: 'GET' });
    // Issuer discovery is fetched by the database: never rate-limited.
    if (path === '/agent-id/.well-known/openid-configuration') return json(200, discovery(env), { 'cache-control': 'public, max-age=300' });
    if (path === '/agent-id/jwks.json') return json(200, jwks(env), { 'cache-control': 'public, max-age=300' });
    if (path === '/health') return health(env);
    if (await ipLimited(env, request)) return TOO_MANY();
    if (path === '/marks/wait') return marksWait(request, env, o);
    if (path === '/.well-known/oauth-protected-resource/mcp' || path === '/.well-known/oauth-protected-resource') {
      return json(200, { resource: o.resource, authorization_servers: [o.idp], scopes_supported: ['board:read', 'board:write'] });
    }
    if (path === '/.well-known/oauth-authorization-server') return authServerMetadata(env, o);
    return notFound();
  }

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const cold = !warm;
      warm = true;
      try {
        // A WebSocket upgrade answers 101 with the socket: withCors would rebuild the response and drop it.
        const url = new URL(request.url);
        if (url.host === origins(env).host && LIVE_PATH.test(url.pathname)) return await live(request, env, url);
        return withCors(await route(request, env, cold));
      } catch (err) {
        const ref = newRef();
        console.error(JSON.stringify({ event: 'http.unhandled_error', ref, error: errorKind(err), cold }));
        return withCors(json(500, { error: 'internal_error', ref }));
      }
    },
  };
}

const ALLOW_ALL: Quota = { check: async () => true };

/** What an entry passes createWorker: each built once per isolate from the Worker's env. */
export type WorkerDeps<E extends Env = Env> = {
  verifyBearer: (env: E) => VerifyBearer;
  users?: (env: E) => UserLookup;
  quota?: (env: E) => Quota;
  tracing?: Pick<Tracing, 'enterSpan'>;
};

/** The canary's flag on the USER Durable Object (worker.ts's User). */
type Flag = { failing(value?: boolean): Promise<boolean> };

/**
 * The Worker's fetch and cron handlers around createApp, with the USER and
 * CAPTURE Durable Objects bound. worker.ts exports it with the open verifiers;
 * a private entry passes its own verifier, user lookup and quota.
 */
export function createWorker<E extends Env>(deps: WorkerDeps<E>) {
  let app: ReturnType<typeof createApp> | undefined;
  const appFor = (env: E) => {
    if (app) return app;
    const service = database(env, () => mint(env, SERVICE_SUBJECT));
    const managed = managedApiKeys(async hash => {
      const safeHash = safeToken(hash)!;
      return (await service.read<ManagedKey>(sql`SELECT * FROM service_workspace_api_keys WHERE key_hash = '${safeHash}'`))[0];
    });
    const existing = deps.verifyBearer(env);
    return app = createApp({
      verifyBearer: authorization => isManagedBearer(authorization) ? managed(authorization) : existing(authorization),
      users: deps.users?.(env),
      quota: deps.quota?.(env),
      ledger: userId => env.USER.get(env.USER.idFromName(userId)) as unknown as Ledger,
      captures: id => env.CAPTURE.get(env.CAPTURE.idFromName(id)) as unknown as CaptureStub,
      tracing: deps.tracing,
    });
  };

  return {
    fetch(request: Request, env: E): Promise<Response> {
      return appFor(env).fetch(request, env);
    },

    // Every 5 minutes (wrangler.jsonc triggers): the canary through our own fetch handler, Demo's reset, then the
    // outcome check; on the first run of each hour, the database load.
    async scheduled(event: ScheduledController, env: E, ctx: ExecutionContext): Promise<void> {
      const flag = env.USER.get(env.USER.idFromName('_canary')) as unknown as Flag;
      // shortcut: hourly, because the service's visible_participant view scans every participant and re-runs on
      // their writes until it expires (10 min unread); read it more often once that view reads by index.
      const load = new Date(event.scheduledTime).getUTCMinutes() < 5 ? dbLoad(database(env, () => mint(env, SERVICE_SUBJECT)), env as unknown as CanaryEnv) : undefined;
      const run = Promise.all([
        scheduled(request => appFor(env).fetch(request, env), env as unknown as CanaryEnv, {
          get: () => flag.failing(),
          set: async failing => void (await flag.failing(failing)),
        }, () => resetDemo(database(env, () => mint(env, SERVICE_SUBJECT)))),
        load,
      ]);
      ctx.waitUntil(run);
      await run;
    },
  } satisfies ExportedHandler<E>;
}

function callContext(env: Env, o: Origins, principal: Principal, deps: Deps, cold: boolean): CallContext {
  const stats = { dbCalls: 0, dbMs: 0, writes: 0 };
  const db = database(env, () => mint(env, principalSubject(principal)), stats);
  const service = database(env, () => mint(env, SERVICE_SUBJECT), stats);
  return {
    env,
    o,
    principal,
    db,
    service,
    ledger: deps.ledger(principal.userId),
    quota: deps.quota ?? ALLOW_ALL,
    captures: deps.captures,
    user: () => principal.machine ? Promise.resolve({ name: principal.machine.name, plan: deps.users ? 'free' : 'self-hosted' }) : (principal.userId === 'user_dev' ? Promise.resolve({ name: 'dev', plan: 'free' }) : userInfo(deps.users ?? selfHostedUsers, principal.userId)),
    log: (line, ref, original) => writeLog(env.CALLS, line, ref, original),
    reqId: newRef() + newRef(),
    cold,
    tracing: deps.tracing,
  };
}

/**
 * One JSON line per tools/call, and one Analytics Engine event; never an email,
 * token, label, path or body (spec §10). double5 (the DB status) is beyond the
 * spec's four doubles: the cron's 402 and lasting-400 checks read it.
 */
export function writeLog(dataset: AnalyticsEngineDataset | undefined, line: LogLine, ref?: string, original?: string) {
  console.log(JSON.stringify({ event: 'tool.call', ...line, ref }));
  if (original) console.error(JSON.stringify({ event: 'tool.error', ref, error: original }));
  dataset?.writeDataPoint({
    indexes: [line.userId],
    blobs: [line.tool, line.outcome, line.clientId, line.via, line.board, line.version],
    doubles: [line.totalMs, line.dbMs, line.dbCalls, line.cold ? 1 : 0, line.status],
  });
}
