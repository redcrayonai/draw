import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveSession, REAUTH_MS, STALE_MS, liveUrl, resolveLive, tapPrompt, type LiveSocketLike, type LiveState } from './live';

class FakeWs implements LiveSocketLike {
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  private on: Record<string, ((ev: { data?: unknown; code?: number; reason?: string }) => void)[]> = {};
  addEventListener(type: string, fn: (ev: { data?: unknown; code?: number; reason?: string }) => void) {
    (this.on[type] ??= []).push(fn);
  }
  emit(type: string, ev: { data?: unknown; code?: number; reason?: string } = {}) {
    if (type === 'open') this.readyState = 1;
    for (const fn of this.on[type] ?? []) fn(ev);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

const last = <T,>(a: T[]): T | undefined => a[a.length - 1];

const window1 = { t: 1, window_ms: 1000, edges: [{ from: '12', to: '13', count: 40, errors: 1, p50: 9, p95: 30, max: 41 }], unmapped: 2 };

describe('liveUrl', () => {
  it('puts the channel on the agent server host', () => {
    expect(liveUrl('https://mcp.example/mcp', 5n)).toBe('wss://mcp.example/live/5');
    expect(liveUrl('http://localhost:8788/mcp', 7n)).toBe('ws://localhost:8788/live/7');
  });
});

describe('resolveLive', () => {
  it('maps node pairs to drawn edges either way round, with calls per second', () => {
    const edges = [{ id: 8n, fromNode: 12n, toNode: 13n }, { id: 9n, fromNode: 16n, toNode: 13n }];
    const w = { ...window1, window_ms: 2000, edges: [window1.edges[0], { from: '13', to: '16', count: 10, errors: 0, p50: 4, p95: 6, max: 7 }, { from: '1', to: '2', count: 1, errors: 0, p50: 1, p95: 1, max: 1 }] };
    expect(resolveLive(w, edges)).toEqual(new Map([
      [8n, { count: 40, errors: 1, p50: 9, p95: 30, rps: 20, reverse: false }],
      [9n, { count: 10, errors: 0, p50: 4, p95: 6, rps: 5, reverse: true }],
    ]));
  });
});

describe('LiveSession', () => {
  afterEach(() => vi.useRealTimers());

  const start = async (token: string | null = 'canvas-token') => {
    const states: LiveState[] = [];
    const windows: unknown[] = [];
    let ws!: FakeWs;
    const s = new LiveSession({
      url: 'wss://x/live/5',
      token: async () => token,
      onState: st => states.push(st),
      onWindow: w => windows.push(w),
      connect: () => (ws = new FakeWs()),
    });
    await s.start();
    return { s, states, windows, ws: () => ws };
  };

  it('authenticates as a viewer, turns Live on, and reports a missing tap', async () => {
    const { states, ws } = await start();
    ws().emit('open');
    expect(ws().sent[0]).toEqual({ auth: 'canvas-token', role: 'viewer' });
    ws().emit('message', { data: JSON.stringify({ ok: true, role: 'viewer' }) });
    expect(ws().sent[1]).toEqual({ live: true });
    ws().emit('message', { data: JSON.stringify({ tap: 'gone' }) });
    expect(states).toEqual([{ kind: 'connecting' }, { kind: 'no-tap' }]);
  });

  it('relays windows, then goes stale after a quiet spell', async () => {
    vi.useFakeTimers();
    const { states, windows, ws } = await start();
    ws().emit('open');
    ws().emit('message', { data: JSON.stringify({ tap: 'connected' }) });
    ws().emit('message', { data: JSON.stringify(window1) });
    expect(last(windows)).toEqual(window1);
    expect(last(states)).toEqual({ kind: 'live', edges: 1, unmapped: 2 });
    vi.advanceTimersByTime(STALE_MS);
    expect(last(windows)).toBeNull();
    expect(last(states)).toEqual({ kind: 'waiting' });
  });

  it('turns Live off before closing, and shows a refusal as a sentence', async () => {
    const a = await start();
    a.ws().emit('open');
    a.s.stop();
    expect(last(a.ws().sent)).toEqual({ live: false });
    expect(a.ws().closed).toBe(true);
    const b = await start();
    b.ws().emit('close', { code: 4001, reason: 'You cannot read this board.' });
    expect(last(b.states)).toEqual({ kind: 'closed', reason: 'You cannot read this board.' });
  });

  it('re-sends a fresh token while connected, so the channel re-checks access, and stops when closed', async () => {
    vi.useFakeTimers();
    let token = 'canvas-token';
    let ws!: FakeWs;
    const s = new LiveSession({ url: 'wss://x/live/5', token: async () => token, onState: () => {}, onWindow: () => {}, connect: () => (ws = new FakeWs()) });
    await s.start();
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ ok: true, role: 'viewer' }) });
    token = 'refreshed';
    await vi.advanceTimersByTimeAsync(REAUTH_MS);
    expect(last(ws.sent)).toEqual({ auth: 'refreshed' });
    s.stop();
    const sent = ws.sent.length;
    await vi.advanceTimersByTimeAsync(REAUTH_MS * 2);
    expect(ws.sent).toHaveLength(sent);
  });

  it('does not connect without a token', async () => {
    const { states, ws } = await start(null);
    expect(ws()).toBeUndefined();
    expect(last(states)?.kind).toBe('closed');
  });

  it('offers a prompt for the agent chat, never a command', () => {
    expect(tapPrompt(5n)).toMatch(/^Start a live tap for board 5 \(call start_tap/);
  });
});
