/**
 * One board's live channel:
 * a tap publishes per-edge summaries, viewers who turned Live on receive them,
 * and the tap is told whether anyone is watching. Nothing here is stored.
 *
 * Plain logic over a socket interface, so it is tested without a Durable
 * Object; the Live DO in worker.ts only adapts hibernatable WebSockets to it.
 */

export type LiveRole = 'tap' | 'viewer';

export type Attachment =
  | { role: 'pending'; board: string; at: number }
  /** sub: who started it (the token's subject); absent on a tap that connected before it was recorded. */
  | { role: 'tap'; board: string; at: number; last: number; strikes: number; sub?: string }
  | { role: 'viewer'; board: string; at: number; live: boolean; checked: number };

export interface LiveSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
  attachment(): Attachment | null;
  setAttachment(a: Attachment): void;
}

export interface LiveDeps {
  /** The board a publish token is for and who it was minted for, or null when it is not a valid tap token. */
  verifyTap(token: string): Promise<{ board: bigint; sub: string } | null>;
  /** Whether this canvas token can read the board. */
  canRead(token: string, board: bigint): Promise<boolean>;
  now(): number;
}

/** A connection must authenticate within this long. */
export const AUTH_MS = 10_000;
/** A tap may publish once per this interval; faster messages are dropped. */
export const MIN_INTERVAL_MS = 500;
export const MAX_EDGES = 500;
/** MAX_EDGES edges of 20-digit node ids and large numbers are ~75 KB; the rest is headroom. */
export const MAX_MESSAGE_BYTES = 128 * 1024;
/** Dropped messages in a row before a tap is closed. */
export const MAX_STRIKES = 20;
export const MAX_VIEWERS = 200;
/** A viewer re-sends a fresh token this often, so a revoked link, grant or membership stops its summaries. */
export const REAUTH_MS = 30_000;
/** A live viewer whose access was last confirmed longer ago than this is closed instead of sent a summary. */
export const ACCESS_TTL_MS = 3 * REAUTH_MS;

/** Close codes (application range): the reason is a sentence the tap or canvas shows. */
export const CLOSE = { auth: 4001, conflict: 4009, abuse: 4008, full: 4013 } as const;

const json = (v: unknown) => JSON.stringify(v);

/** The board's tap, if any, and whether anyone has Live on (tap_status). Times are ms since the epoch. */
export type LiveStatus = { tap: boolean; since: number | null; lastPublish: number | null; sub: string | null; watching: boolean };

/** The Live Durable Object as the tools call it. */
export type LiveStub = { status(): Promise<LiveStatus> };

export class LiveHub {
  /** Sockets whose auth frame is being checked: a DO delivers frames during the check's fetch, so others are dropped. */
  private authing = new WeakSet<LiveSocket>();

  constructor(private deps: LiveDeps, private sockets: () => LiveSocket[]) {}

  /** Sockets in a role; `except` leaves out one that is closing but may still be listed. */
  private role(role: LiveRole, except?: LiveSocket): LiveSocket[] {
    return this.sockets().filter(s => s !== except && s.attachment()?.role === role);
  }

  private watching(except?: LiveSocket): boolean {
    return this.role('viewer', except).some(s => (s.attachment() as { live: boolean }).live);
  }

  /** Tell the tap, if any, whether anyone is watching now. */
  private notifyTap(except?: LiveSocket): void {
    const w = this.watching(except);
    for (const t of this.role('tap', except)) t.send(json({ watching: w }));
  }

  async message(ws: LiveSocket, raw: string): Promise<void> {
    const a = ws.attachment();
    if (!a) return;
    if (a.role === 'pending') {
      if (this.authing.has(ws)) return;
      this.authing.add(ws);
      try {
        return await this.authenticate(ws, a, raw);
      } finally {
        this.authing.delete(ws);
      }
    }
    if (a.role === 'viewer') {
      let msg: { live?: unknown; auth?: unknown };
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (typeof msg.auth === 'string') return this.recheck(ws, a, msg.auth);
      if (typeof msg.live !== 'boolean' || msg.live === a.live) return;
      ws.setAttachment({ ...a, live: msg.live });
      this.notifyTap();
      return;
    }
    // tap: rate and size limits, then fan out to the viewers who are watching
    const now = this.deps.now();
    const tooSoon = now - a.last < MIN_INTERVAL_MS;
    const tooBig = raw.length > MAX_MESSAGE_BYTES;
    let body: { edges?: unknown } | null = null;
    if (!tooSoon && !tooBig) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
    }
    const valid = body !== null && typeof body === 'object' && Array.isArray(body.edges) && body.edges.length <= MAX_EDGES;
    if (!valid) {
      const strikes = a.strikes + 1;
      ws.setAttachment({ ...a, strikes });
      if (strikes >= MAX_STRIKES) ws.close(CLOSE.abuse, 'The tap sent too many messages too fast or too large; it was disconnected.');
      return;
    }
    ws.setAttachment({ ...a, last: now, strikes: 0 });
    for (const v of this.role('viewer')) {
      const va = v.attachment() as Extract<Attachment, { role: 'viewer' }>;
      if (!va.live) continue;
      if (now - va.checked > ACCESS_TTL_MS) v.close(CLOSE.auth, 'Live could not re-check that you can read this board. Turn Live on again.');
      else v.send(raw);
    }
  }

  /** A viewer's periodic token: still readable, or the socket closes. Each check is a database query, so at most one per socket at a time and per half interval. */
  private async recheck(ws: LiveSocket, a: Extract<Attachment, { role: 'viewer' }>, token: string): Promise<void> {
    const now = this.deps.now();
    if (this.authing.has(ws) || now - a.checked < REAUTH_MS / 2) return;
    this.authing.add(ws);
    try {
      if (!(await this.deps.canRead(token, BigInt(a.board)))) return ws.close(CLOSE.auth, 'You can no longer read this board.');
      const current = ws.attachment();
      if (current?.role === 'viewer') ws.setAttachment({ ...current, checked: now });
    } finally {
      this.authing.delete(ws);
    }
  }

  private async authenticate(ws: LiveSocket, a: Extract<Attachment, { role: 'pending' }>, raw: string): Promise<void> {
    let msg: { auth?: unknown; role?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      msg = {};
    }
    const fail = (reason: string) => ws.close(CLOSE.auth, reason);
    if (typeof msg.auth !== 'string' || (msg.role !== 'tap' && msg.role !== 'viewer')) return fail('The first message must be { auth, role }.');
    const board = BigInt(a.board);
    const at = this.deps.now();
    if (msg.role === 'tap') {
      const claims = await this.deps.verifyTap(msg.auth);
      if (!claims || claims.board !== board) return fail('This tap token is not valid for this board. Ask your agent for a new one (start_tap).');
      if (this.role('tap', ws).length > 0) return ws.close(CLOSE.conflict, 'Another tap is already live for this board.');
      ws.setAttachment({ role: 'tap', board: a.board, at, last: 0, strikes: 0, sub: claims.sub });
      ws.send(json({ ok: true, role: 'tap' }));
      ws.send(json({ watching: this.watching() }));
      for (const v of this.role('viewer')) v.send(json({ tap: 'connected' }));
      return;
    }
    if (!(await this.deps.canRead(msg.auth, board))) return fail('You cannot read this board.');
    if (this.role('viewer').length >= MAX_VIEWERS) return ws.close(CLOSE.full, 'Too many viewers on this board right now.');
    ws.setAttachment({ role: 'viewer', board: a.board, at, live: false, checked: at });
    ws.send(json({ ok: true, role: 'viewer' }));
    ws.send(json({ tap: this.role('tap').length > 0 ? 'connected' : 'gone' }));
  }

  status(): LiveStatus {
    const t = this.role('tap')[0]?.attachment() as Extract<Attachment, { role: 'tap' }> | undefined;
    return { tap: t !== undefined, since: t?.at ?? null, lastPublish: t && t.last > 0 ? t.last : null, sub: t?.sub ?? null, watching: this.watching() };
  }

  closed(ws: LiveSocket): void {
    const a = ws.attachment();
    if (a?.role === 'tap') {
      for (const v of this.role('viewer', ws)) v.send(json({ tap: 'gone' }));
    } else if (a?.role === 'viewer' && a.live) {
      this.notifyTap(ws);
    }
  }

  /** Close connections that never authenticated; returns whether any are still waiting. */
  sweep(): boolean {
    const now = this.deps.now();
    let waiting = false;
    for (const s of this.sockets()) {
      const a = s.attachment();
      if (a?.role !== 'pending') continue;
      if (now - a.at >= AUTH_MS) s.close(CLOSE.auth, 'No authentication received.');
      else waiting = true;
    }
    return waiting;
  }
}
