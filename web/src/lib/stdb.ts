// Session-bound SpacetimeDB connection for the dashboard (spec §3.2).
//   - a fresh token per connect (account tokens can live 60 s and SpacetimeDB checks
//     exp only at connect)
//   - a generation counter plus the per-connection `stale()` check turn every
//     late callback (old account, twin onerror+onclose) into a no-op
//   - subscribes only to caller views, never participant/cursor/
//     selection; joinAs() names the account user for activity rows, and the
//     dashboard still never shows on canvases (presence needs a cursor or
//     selection row, which it never writes)
import { get, writable, type Readable } from 'svelte/store';
import { Identity, Timestamp } from 'spacetimedb';
import { DbConnection } from '../module_bindings';
import type { AgentGrantRow, AgentLinkRow, BoardSlugRow, MyBoard, MyCodeConsentRow } from '../module_bindings/types';
import { config } from './config';
import { attachWorkspaces, resetWorkspaces } from './workspaces';
import { attachPlugins, resetPlugins } from './plugins';
import { toEvent, type ActivityResult } from './activity';
import type { ArchitectureHistory, ArchitectureVersion } from './history';
import { clearAnonymousToken, readAnonymousToken, saveAnonymousToken } from './anonymous-identity';

export type StdbState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'live' }
  | { status: 'reconnecting'; error: string } // rows kept: same identity
  | { status: 'error'; error: string }; // not retried, e.g. the module predates the views
/** string = account token; undefined = anonymous (no accounts configured);
 * null = signed out. Throwing means a transient failure: retried. */
export type TokenSource = () => Promise<string | null | undefined>;
type Builder = ReturnType<typeof DbConnection.builder>;

// Same key shape as the canvas (client/src/main.ts ANON_TOKEN_KEY).
export const ANON_TOKEN_KEY = `stdb_token:${config.spacetimeUri}/${config.spacetimeDb}`;
const shareAnonymousIdentity = () => import.meta.env.DEV && !config.accounts;
// User-facing sentences name "the board server", never the vendor or its address.
const MISSING_VIEW = 'The board server is older than this dashboard. Deploy the latest server, then reload.';
const UNAVAILABLE = 'The board server could not load your boards. Reload, or try again shortly.';
const OLD_ACTIVITY = 'Activity needs the latest board server. Update the server and reload.';

const state = writable<StdbState>({ status: 'idle' });
const boards = writable<MyBoard[]>([]);
const links = writable<AgentLinkRow[]>([]);
const grants = writable<AgentGrantRow[]>([]);
const histories = writable<ArchitectureHistory[]>([]);
const versions = writable<ArchitectureVersion[]>([]);
const slugs = writable<Map<bigint, string>>(new Map());
const consent = writable<MyCodeConsentRow | null>(null);
const activity = writable<ActivityResult | null>(null);
const me = writable('');
export const stdbState: Readable<StdbState> = { subscribe: state.subscribe };
export const myBoards: Readable<MyBoard[]> = { subscribe: boards.subscribe };
export const myAgentLinks: Readable<AgentLinkRow[]> = { subscribe: links.subscribe };
export const myAgentGrants: Readable<AgentGrantRow[]> = { subscribe: grants.subscribe };
export const myArchitectureHistories: Readable<ArchitectureHistory[]> = { subscribe: histories.subscribe };
export const architectureVersions: Readable<ArchitectureVersion[]> = { subscribe: versions.subscribe };
/** board id → its #b= link id, for canvas links (my_board_slugs). */
export const boardSlugs: Readable<Map<bigint, string>> = { subscribe: slugs.subscribe };
/** The caller's code-snippet setting; null until the rows arrive. Not cached: the settings page must never show a stale answer. */
export const myCodeConsent: Readable<MyCodeConsentRow | null> = { subscribe: consent.subscribe };
/** The caller's activity feed (my_activity), newest first, live; null until it loads. */
export const myActivity: Readable<ActivityResult | null> = { subscribe: activity.subscribe };
export const identityHex: Readable<string> = { subscribe: me.subscribe };

// The last rows each account saw, painted on the next visit before the socket
// is live (about 0.4 s later); the subscription then replaces them. Rows only,
// never a token. Cleared on sign-out (session.ts).
const ROWS_PREFIX = 'dash_rows:';
const rowsKey = (k: string) => `${ROWS_PREFIX}${config.spacetimeUri}/${config.spacetimeDb}:${k}`;
type Rows = { boards: MyBoard[]; links: AgentLinkRow[]; grants: AgentGrantRow[]; histories: ArchitectureHistory[]; versions: ArchitectureVersion[]; slugs?: BoardSlugRow[] };
const setSlugs = (rows: BoardSlugRow[] = []) => slugs.set(new Map(rows.map((r) => [r.boardId, r.slug])));

function saveRows(k: string, rows: Rows): void {
  try {
    localStorage.setItem(rowsKey(k), JSON.stringify(rows, (_k, v) =>
      typeof v === 'bigint' ? { $n: String(v) }
      : v instanceof Timestamp ? { $t: String(v.microsSinceUnixEpoch) }
      : v instanceof Identity ? { $i: v.toHexString() }
      : v));
  } catch { /* full or blocked storage only costs the head start */ }
}

function loadRows(k: string): Rows | null {
  try {
    const raw = localStorage.getItem(rowsKey(k));
    return raw && JSON.parse(raw, (_k, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? '$n' in v ? BigInt(v.$n) : '$t' in v ? new Timestamp(BigInt(v.$t)) : '$i' in v ? new Identity(v.$i) : v
        : v);
  } catch {
    return null; // a row shape from an older build: wait for the live rows
  }
}

/** Sign-out: forget every account's cached rows on this device. */
export function clearCachedRows(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(ROWS_PREFIX)) localStorage.removeItem(k);
  } catch { /* storage blocked: nothing was cached */ }
}

let gen = 0;
let attempt = 0;
let suspect = false;
let key: string | null = null;
let source: TokenSource | null = null;
let conn: DbConnection | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let builder: () => Builder = () => DbConnection.builder();

const why = (e: unknown): string => (e as { message?: string } | undefined)?.message || String(e);
/** SDK connect failures as a sentence: the WebSocket `error` is a bare DOM
 * Event and an unreachable host fails the token fetch with a TypeError. */
const connectWhy = (e: unknown): string => {
  if (e instanceof Event || e instanceof TypeError) return 'Cannot reach the board server. Check your connection.';
  const msg = why(e);
  return msg.includes('verify token') ? 'The board server could not verify your sign-in. Sign in again.' : msg;
};

/** The connection for reducer calls, or null while not live. */
export function getConn(): DbConnection | null {
  return get(state).status === 'live' ? conn : null;
}

let joined: { c: DbConnection; name: string } | null = null;

/** Sets the participant name of account `k` on the live connection, once per
 * connection and name, so this user's activity rows carry it instead of ''. */
export function joinAs(k: string, displayName: string): void {
  const c = getConn();
  if (!c || k !== key || !displayName || (joined?.c === c && joined.name === displayName)) return;
  joined = { c, name: displayName };
  c.reducers.joinBoard({ displayName, kind: 'human' }).catch((e) => console.warn('joinBoard failed:', why(e)));
}

/** Connects as account `k` unless already connected as `k`. `deps` is the test seam. */
export function connectAs(k: string, tokens: TokenSource, deps: { builder?: () => Builder } = {}): void {
  if (k === key) return;
  disconnect();
  key = k;
  source = tokens;
  builder = deps.builder ?? (() => DbConnection.builder());
  const cached = loadRows(k);
  if (cached) {
    boards.set(cached.boards);
    links.set(cached.links);
    grants.set(cached.grants);
    histories.set(cached.histories);
    versions.set(cached.versions);
    setSlugs(cached.slugs); // absent in rows cached before slugs: links wait for the live rows
  }
  void open(gen, tokens);
}

/** Sign-out or account change: drop the socket and clear every row now. */
export function disconnect(): void {
  gen++;
  key = null;
  source = null;
  attempt = 0;
  suspect = false;
  clearTimeout(timer);
  const c = conn;
  conn = null;
  c?.disconnect(); // its callbacks are now stale
  resetWorkspaces();
  resetPlugins();
  boards.set([]);
  links.set([]);
  grants.set([]);
  histories.set([]);
  versions.set([]);
  setSlugs();
  consent.set(null);
  activity.set(null);
  me.set('');
  state.set({ status: 'idle' });
}

/** Bearer token for /api/*: a fresh account token when signed in, the stored
 * anonymous token in dev mode, null when not connected. */
export async function apiToken(): Promise<string | null> {
  if (!source) return null;
  const t = await source();
  return t === undefined ? readAnonymousToken(ANON_TOKEN_KEY, shareAnonymousIdentity()) : t;
}

async function open(g: number, tokens: TokenSource): Promise<void> {
  if (!attempt) state.set({ status: 'connecting' });
  let token: string | null | undefined;
  try {
    token = await tokens();
  } catch (e) {
    return retry(g, tokens, why(e));
  }
  if (g !== gen) return; // account changed or signed out while awaiting the provider
  if (token === null) return disconnect();
  const anon = token === undefined;
  if (anon) token = readAnonymousToken(ANON_TOKEN_KEY, shareAnonymousIdentity()) ?? undefined;
  const usedStored = anon && token !== undefined;

  let self: DbConnection | null = null;
  const stale = () => g !== gen || self === null || self !== conn;
  const b = builder()
    .withUri(config.spacetimeUri)
    .withDatabaseName(config.spacetimeDb)
    .onConnect((c, identity, issued) => {
      if (stale()) {
        c.disconnect();
        return;
      }
      suspect = false;
      // anonymous only: keep the server-issued long-lived token so the dev
      // identity is stable; account tokens are never persisted (RC-528)
      if (anon && issued) saveAnonymousToken(ANON_TOKEN_KEY, issued, shareAnonymousIdentity());
      const rebuild = () => {
        if (stale()) return;
        const rows: Rows = {
          boards: [...c.db.myBoards.iter()],
          links: [...c.db.myAgentLinks.iter()],
          grants: [...c.db.myAgentGrants.iter()],
          histories: [...c.db.myArchitectureHistories.iter()],
          versions: [...c.db.visibleArchitectureVersion.iter()],
          slugs: [...c.db.myBoardSlugs.iter()],
        };
        boards.set(rows.boards);
        links.set(rows.links);
        grants.set(rows.grants);
        histories.set(rows.histories);
        versions.set(rows.versions);
        setSlugs(rows.slugs);
        consent.set(c.db.myCodeConsent.iter().next().value ?? null);
        if (key) saveRows(key, rows);
      };
      // A transaction fires one callback per row; rebuild once after all of them.
      let queued = false;
      const sync = () => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          rebuild();
        });
      };
      c.db.myBoards.onInsert(sync);
      c.db.myBoards.onDelete(sync);
      c.db.myBoards.onUpdate(sync); // primary-keyed view rows change as updates
      c.db.myAgentLinks.onInsert(sync);
      c.db.myAgentLinks.onDelete(sync);
      c.db.myAgentLinks.onUpdate(sync);
      c.db.myAgentGrants.onInsert(sync);
      c.db.myAgentGrants.onDelete(sync);
      c.db.myAgentGrants.onUpdate(sync);
      for (const table of [c.db.myArchitectureHistories, c.db.visibleArchitectureVersion, c.db.myBoardSlugs, c.db.myCodeConsent]) {
        table.onInsert(sync);
        table.onDelete(sync);
        table.onUpdate(sync);
      }
      attachWorkspaces(c, stale);
      attachPlugins(c, stale);
      // The feed has a subscription of its own: a server without my_activity
      // blanks the Activity panel, not the boards.
      const feed = () => {
        if (stale()) return;
        const events = [...c.db.myActivity.iter()].map(toEvent);
        events.sort((a, b) => b.lastAt.localeCompare(a.lastAt) || Number(BigInt(b.id) - BigInt(a.id)));
        activity.set({ events });
      };
      let feedQueued = false;
      const syncFeed = () => {
        if (feedQueued) return;
        feedQueued = true;
        queueMicrotask(() => {
          feedQueued = false;
          feed();
        });
      };
      c.db.myActivity.onInsert(syncFeed);
      c.db.myActivity.onDelete(syncFeed);
      c.db.myActivity.onUpdate(syncFeed); // a burst merging moves its row forward
      c.subscriptionBuilder()
        .onApplied(feed)
        .onError(() => {
          if (!stale()) activity.set({ error: OLD_ACTIVITY });
        })
        .subscribe(['SELECT * FROM my_activity']);
      c.subscriptionBuilder()
        .onApplied(() => {
          if (stale()) return;
          attempt = 0;
          me.set(identity.toHexString());
          rebuild();
          state.set({ status: 'live' });
        })
        .onError((ctx) => {
          if (stale()) return;
          const msg = why(ctx.event ?? 'subscription failed');
          if (!/no such table/i.test(msg)) console.error('my_boards subscription failed:', msg); // the detail stays in the console
          state.set({ status: 'error', error: /no such table/i.test(msg) ? MISSING_VIEW : UNAVAILABLE });
        })
        .subscribe(['SELECT * FROM my_boards', 'SELECT * FROM my_agent_links', 'SELECT * FROM my_agent_grants', 'SELECT * FROM my_architecture_histories', 'SELECT * FROM visible_architecture_version', 'SELECT * FROM my_board_slugs', 'SELECT * FROM my_code_consent']);
    })
    .onConnectError((_c, err) => {
      if (stale()) return;
      // A stale anonymous token (e.g. after a local server reset) would wedge
      // every retry, but the SDK reports a 401 and a 5xx alike: drop it only
      // on the second consecutive failure (same rule as the canvas).
      if (usedStored && why(err).includes('verify token')) {
        if (suspect) clearAnonymousToken(ANON_TOKEN_KEY, shareAnonymousIdentity());
        suspect = !suspect;
      }
      retry(g, tokens, connectWhy(err));
    })
    .onDisconnect((_c, err) => {
      if (!stale()) retry(g, tokens, err ? why(err) : 'connection closed');
    });
  if (token !== undefined) b.withToken(token); // RC-528: never a null token
  try {
    conn = self = b.build();
  } catch (e) {
    console.error('connection setup failed:', e);
    state.set({ status: 'error', error: UNAVAILABLE });
  }
}

function retry(g: number, tokens: TokenSource, reason: string): void {
  if (g !== gen) return;
  const c = conn;
  conn = null; // the twin onerror/onclose callback is now stale
  c?.disconnect();
  const ms = Math.min(1000 * 2 ** attempt++, 30_000);
  state.set({ status: 'reconnecting', error: reason });
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (g === gen) void open(g, tokens);
  }, ms);
}
