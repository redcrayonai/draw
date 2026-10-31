/**
 * The canvas side of the live tap:
 * a viewer connection to the board's live channel, opened only while Live is on.
 */
import type { Edge } from './module_bindings/types';
import type { LiveEdge } from './render';

export interface LiveWindowEdge {
  from: string;
  to: string;
  count: number;
  errors: number;
  p50: number;
  p95: number;
  max: number;
}

export interface LiveWindow {
  t: number;
  window_ms: number;
  edges: LiveWindowEdge[];
  unmapped: number;
}

export type LiveState =
  | { kind: 'connecting' }
  /** Connected, but no tap is running for this board. */
  | { kind: 'no-tap' }
  /** A tap is connected; no traffic in the last few seconds. */
  | { kind: 'waiting' }
  | { kind: 'live'; edges: number; unmapped: number }
  | { kind: 'closed'; reason: string };

/** Live data older than this stops flowing on the board. */
export const STALE_MS = 3000;
/** How often a connected viewer sends a fresh token, so the channel re-checks its access (mcp/src/live.ts REAUTH_MS). */
export const REAUTH_MS = 30_000;

/** The live channel for a board, on the same host as the hosted agent server (`https://mcp.x/mcp`). */
export function liveUrl(mcpUrl: string, board: bigint): string {
  const u = new URL(mcpUrl);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  u.pathname = `/live/${board}`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** A window's node pairs as edges on this board: the drawn edge either way round, reversed when the calls run against it. */
export function resolveLive(w: LiveWindow, edges: readonly Pick<Edge, 'id' | 'fromNode' | 'toNode'>[]): Map<bigint, LiveEdge> {
  const out = new Map<bigint, LiveEdge>();
  const seconds = Math.max(0.001, w.window_ms / 1000);
  for (const s of w.edges) {
    let from: bigint, to: bigint;
    try {
      from = BigInt(s.from);
      to = BigInt(s.to);
    } catch {
      continue;
    }
    const fwd = edges.find(e => e.fromNode === from && e.toNode === to);
    const back = fwd ? undefined : edges.find(e => e.fromNode === to && e.toNode === from);
    const edge = fwd ?? back;
    if (!edge) continue;
    out.set(edge.id, { count: s.count, errors: s.errors, p50: s.p50, p95: s.p95, rps: s.count / seconds, reverse: back !== undefined });
  }
  return out;
}

/** The subset of WebSocket the session uses, so tests can drive it. */
export interface LiveSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'message', fn: (ev: { data?: unknown; code?: number; reason?: string }) => void): void;
}

export interface LiveSessionOpts {
  url: string;
  /** The token the canvas holds for the database; null when there is none. */
  token(): Promise<string | null>;
  onState(s: LiveState): void;
  /** A new window, or null when the data went stale. */
  onWindow(w: LiveWindow | null): void;
  connect?(url: string): LiveSocketLike;
}

/** One Live session: authenticate as a viewer, turn Live on, relay windows until stop(). */
export class LiveSession {
  private ws: LiveSocketLike | null = null;
  private stale: ReturnType<typeof setTimeout> | undefined;
  private reauth: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private opts: LiveSessionOpts) {}

  async start(): Promise<void> {
    this.opts.onState({ kind: 'connecting' });
    const token = await this.opts.token();
    if (this.stopped) return;
    if (!token) {
      this.opts.onState({ kind: 'closed', reason: 'Live needs the board to be connected first.' });
      return;
    }
    const ws = (this.opts.connect ?? (url => new WebSocket(url) as unknown as LiveSocketLike))(this.opts.url);
    this.ws = ws;
    ws.addEventListener('open', () => ws.send(JSON.stringify({ auth: token, role: 'viewer' })));
    ws.addEventListener('message', ev => this.message(String(ev.data)));
    ws.addEventListener('close', ev => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearStale();
      clearInterval(this.reauth);
      this.opts.onWindow(null);
      if (!this.stopped) this.opts.onState({ kind: 'closed', reason: ev.reason || 'The live channel closed.' });
    });
  }

  private message(raw: string): void {
    let msg: { ok?: boolean; tap?: string } & Partial<LiveWindow>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.ok) {
      const ws = this.ws;
      ws?.send(JSON.stringify({ live: true }));
      clearInterval(this.reauth);
      this.reauth = setInterval(() => {
        void this.opts.token().then(token => {
          if (token && this.ws === ws && ws?.readyState === 1) ws.send(JSON.stringify({ auth: token }));
        });
      }, REAUTH_MS);
      return;
    }
    if (msg.tap === 'gone') {
      this.clearStale();
      this.opts.onWindow(null);
      this.opts.onState({ kind: 'no-tap' });
      return;
    }
    if (msg.tap === 'connected') {
      this.opts.onState({ kind: 'waiting' });
      return;
    }
    if (Array.isArray(msg.edges)) {
      const w = msg as LiveWindow;
      this.opts.onWindow(w);
      this.opts.onState({ kind: 'live', edges: w.edges.length, unmapped: w.unmapped ?? 0 });
      this.clearStale();
      this.stale = setTimeout(() => {
        this.opts.onWindow(null);
        this.opts.onState({ kind: 'waiting' });
      }, STALE_MS);
    }
  }

  private clearStale(): void {
    if (this.stale !== undefined) clearTimeout(this.stale);
    this.stale = undefined;
  }

  stop(): void {
    this.stopped = true;
    this.clearStale();
    clearInterval(this.reauth);
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ live: false }));
    ws?.close();
    this.opts.onWindow(null);
  }
}

/** How much live history the canvas keeps per edge, and the bucket a saved chart shows per row. */
export const HISTORY_MS = 15 * 60 * 1000;
export const BUCKET_MS = 10_000;
/** The source a saved live chart carries: how "Save as charts" finds its own charts again. */
export const LIVE_CHART_SOURCE = 'live tap';

export interface LivePoint {
  /** The window's end, epoch ms (the tap machine's clock). */
  t: number;
  count: number;
  p50: number;
  p95: number;
}

/** Add one window's edges to the per-edge history, and drop what is older than HISTORY_MS. */
export function recordLive(history: Map<bigint, LivePoint[]>, t: number, edges: ReadonlyMap<bigint, LiveEdge>): void {
  for (const [id, e] of edges) {
    if (e.count <= 0) continue;
    const points = history.get(id) ?? [];
    points.push({ t, count: e.count, p50: e.p50, p95: e.p95 });
    history.set(id, points);
  }
  for (const [id, points] of history) {
    const kept = points.filter(p => t - p.t <= HISTORY_MS);
    if (kept.length === 0) history.delete(id);
    else history.set(id, kept);
  }
}

/**
 * One edge's history as a time series chart's CSV, a row per BUCKET_MS:
 * the call-weighted mean of each window's p50 and p95, in ms.
 */
export function liveCsv(points: readonly LivePoint[]): string {
  const buckets = new Map<number, { n: number; p50: number; p95: number }>();
  for (const p of points) {
    const at = Math.floor(p.t / BUCKET_MS) * BUCKET_MS;
    const b = buckets.get(at) ?? { n: 0, p50: 0, p95: 0 };
    b.n += p.count;
    b.p50 += p.p50 * p.count;
    b.p95 += p.p95 * p.count;
    buckets.set(at, b);
  }
  const round = (v: number) => Math.round(v * 10) / 10;
  const rows = [...buckets].sort((a, b) => a[0] - b[0]).map(([at, b]) => `${new Date(at).toISOString()},${round(b.p50 / b.n)},${round(b.p95 / b.n)}`);
  return ['time,p50,p95', ...rows].join('\n');
}

/** What to paste into the agent's chat when no tap runs: the board stays one-way. */
export const tapPrompt = (board: bigint) =>
  `Start a live tap for board ${board} (call start_tap, write .redcrayon/tap.json, run the command it returns) so I can watch live traffic.`;
