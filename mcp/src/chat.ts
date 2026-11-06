/**
 * One board's agent chat: the person running an agent talks to it from the
 * canvas. A helper connects as `agent` with a start_chat token; a browser
 * connects as `person`, and hears from and speaks to only the agents its own
 * token shows it linked (my_agent_links). Nothing here is stored: the queue and
 * the history live in the helper, on the person's machine.
 * Agents advertise an optional ChatSession at auth; people receive `sessions`
 * and choose one with `select`. Commands and events never cross that selection.
 *
 * Plain logic over a socket interface, like live.ts; the Chat DO in worker.ts
 * only adapts hibernatable WebSockets to it.
 */

import { CHAT_VIEWER_TTL_MS, type ChatSession } from '../../shared/chat';

type Selection = { id: string; agent: string };
export type ChatAttachment =
  | { role: 'pending'; board: string; at: number }
  | { role: 'agent'; board: string; at: number; agent: string; strikes: number; session?: ChatSession }
  | { role: 'person'; board: string; at: number; agents: string[]; checked: number; selected?: Selection | null; viewing?: boolean };
type Agent = Extract<ChatAttachment, { role: 'agent' }>;
type Person = Extract<ChatAttachment, { role: 'person' }>;

export interface ChatSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
  attachment(): ChatAttachment | null;
  setAttachment(a: ChatAttachment): void;
}

export interface ChatDeps {
  verifyAgent(token: string): Promise<{ agent: string; board: bigint } | null>;
  linkedAgents(token: string, board: bigint): Promise<string[] | null>;
  now(): number;
}

export const CHAT_AUTH_MS = 10_000;
export const CHAT_MAX_BYTES = 64 * 1024;
export const CHAT_MAX_AGENT_BYTES = 1024 * 1024;
export const CHAT_MAX_STRIKES = 20;
export const CHAT_REAUTH_MS = 30_000;
const ACCESS_TTL_MS = CHAT_VIEWER_TTL_MS;
export const CHAT_CLOSE = { auth: 4001, replaced: 4009, abuse: 4008 } as const;
const AGENT_TYPES = new Set(['snapshot', 'state', 'queue', 'delivered', 'text', 'user', 'tool', 'notice', 'approval']);
const PERSON_TYPES = new Set(['send', 'receipt', 'delete', 'stop', 'resume', 'approval']);
const json = (v: unknown) => JSON.stringify(v);
const bytes = (v: string) => new TextEncoder().encode(v).byteLength;
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && bytes(v) <= max && !/[\u0000-\u001f\u007f]/.test(v);
const descriptor = (a: Agent): ChatSession => a.session ?? { id: `legacy:${a.agent}`, agent: 'agent', name: 'Agent conversation', capabilities: { stop: 'step', approvals: false } };

function sessionDescriptor(value: unknown): ChatSession | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as ChatSession;
  if (!bounded(s.id, 256) || !bounded(s.agent, 80) || !bounded(s.name, 160) || !s.capabilities ||
      !['interrupt', 'step', 'none'].includes(s.capabilities.stop) || typeof s.capabilities.approvals !== 'boolean') return null;
  return { id: s.id, agent: s.agent, name: s.name, capabilities: { stop: s.capabilities.stop, approvals: s.capabilities.approvals } };
}

export class ChatHub {
  private authing = new WeakSet<ChatSocket>();
  private ended = new WeakSet<ChatSocket>();

  constructor(private deps: ChatDeps, private sockets: () => ChatSocket[]) {}

  private close(ws: ChatSocket, code: number, reason: string): void {
    this.ended.add(ws);
    ws.close(code, reason);
    const a = ws.attachment();
    if (a?.role === 'agent' && code !== CHAT_CLOSE.replaced) this.announce(a.agent);
    if (a?.role === 'person') this.presence();
  }

  private presence(): void {
    for (const { socket } of this.online()) {
      const count = this.sockets().filter(p => {
        const a = p.attachment();
        return !this.ended.has(p) && a?.role === 'person' && a.viewing === true &&
          this.deps.now() - a.checked <= ACCESS_TTL_MS && this.selected(a) === socket;
      }).length;
      socket.send(json({ type: 'viewers', count }));
    }
  }

  private online(): { socket: ChatSocket; attachment: Agent; session: ChatSession }[] {
    return this.sockets().flatMap(socket => {
      const a = socket.attachment();
      return !this.ended.has(socket) && a?.role === 'agent' ? [{ socket, attachment: a, session: descriptor(a) }] : [];
    });
  }

  private selected(a: Person): ChatSocket | undefined {
    return this.online().find(s => s.session.id === a.selected?.id && s.attachment.agent === a.selected.agent && a.agents.includes(s.attachment.agent))?.socket;
  }

  private advertise(ws: ChatSocket): void {
    const a = ws.attachment();
    if (a?.role !== 'person' || this.ended.has(ws)) return;
    const sessions = this.online().filter(s => a.agents.includes(s.attachment.agent));
    // Keep the chosen identity through disconnects; a different agent cannot inherit it.
    if (!a.selected && sessions.length === 1) {
      a.selected = { id: sessions[0].session.id, agent: sessions[0].attachment.agent };
      ws.setAttachment(a);
    }
    ws.send(json({ type: 'sessions', sessions: sessions.map(s => s.session), selected: a.selected?.id ?? null }));
    ws.send(json({ agent: this.selected(a) ? 'connected' : 'gone' }));
  }

  private announce(agent: string): void {
    for (const ws of this.sockets()) {
      const a = ws.attachment();
      if (a?.role === 'person' && a.agents.includes(agent)) this.advertise(ws);
    }
  }

  private fresh(ws: ChatSocket, a: Person): boolean {
    if (this.deps.now() - a.checked <= ACCESS_TTL_MS) return true;
    this.close(ws, CHAT_CLOSE.auth, 'Chat could not re-check your access. Open it again.');
    return false;
  }

  async message(ws: ChatSocket, raw: string): Promise<void> {
    const a = ws.attachment();
    if (!a || this.ended.has(ws)) return;
    if (bytes(raw) > (a.role === 'agent' ? CHAT_MAX_AGENT_BYTES : CHAT_MAX_BYTES)) {
      if (a.role !== 'agent') return this.close(ws, CHAT_CLOSE.abuse, 'That message is too long to send.');
      const strikes = a.strikes + 1;
      ws.setAttachment({ ...a, strikes });
      if (strikes >= CHAT_MAX_STRIKES) this.close(ws, CHAT_CLOSE.abuse, 'The agent sent too many oversized messages; it was disconnected.');
      return;
    }
    if (a.role === 'pending') {
      if (this.authing.has(ws)) return;
      this.authing.add(ws);
      try { return await this.authenticate(ws, a, raw); }
      finally { this.authing.delete(ws); }
    }
    if (a.role === 'agent') {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(raw); } catch { return; }
      if (!frame || typeof frame.type !== 'string' || !AGENT_TYPES.has(frame.type)) return;
      const session = descriptor(a);
      const scoped = json({ ...frame, session: frame.type === 'snapshot' ? session : session.id });
      for (const p of this.sockets()) {
        const person = p.attachment();
        if (!this.ended.has(p) && !this.authing.has(p) && person?.role === 'person' && this.selected(person) === ws && this.fresh(p, person)) p.send(scoped);
      }
      return;
    }
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.auth === 'string') return this.recheck(ws, a, msg.auth, msg.sync === true);
    if (!this.fresh(ws, a) || this.authing.has(ws)) return;
    if (msg.type === 'select') {
      const choice = this.online().find(s => s.session.id === msg.session && a.agents.includes(s.attachment.agent));
      if (!choice) return;
      ws.setAttachment({ ...a, selected: { id: choice.session.id, agent: choice.attachment.agent } });
      this.advertise(ws);
      choice.socket.send(json({ type: 'joined' }));
      this.presence();
      return;
    }
    if (msg.type === 'viewing' && typeof msg.active === 'boolean') {
      if (msg.session !== undefined && msg.session !== a.selected?.id) return;
      ws.setAttachment({ ...a, viewing: msg.active });
      this.presence();
      return;
    }
    if (typeof msg.type !== 'string' || !PERSON_TYPES.has(msg.type)) return;
    if (msg.session !== undefined && msg.session !== a.selected?.id) return;
    if (msg.type === 'approval' && (!bounded(msg.id, 256) || (msg.decision !== 'accept' && msg.decision !== 'decline'))) return;
    this.selected(a)?.send(raw);
  }

  private async recheck(ws: ChatSocket, a: Person, token: string, sync: boolean): Promise<void> {
    const now = this.deps.now();
    if (this.authing.has(ws)) return;
    if (now - a.checked < CHAT_REAUTH_MS / 2) {
      if (sync) this.selected(a)?.send(json({ type: 'joined' }));
      return;
    }
    this.authing.add(ws);
    try {
      const agents = await this.deps.linkedAgents(token, BigInt(a.board));
      if (this.ended.has(ws)) return;
      if (!agents?.length) return this.close(ws, CHAT_CLOSE.auth, 'You can no longer chat with an agent on this board.');
      const current = ws.attachment();
      if (current?.role !== 'person') return;
      const next = { ...current, agents, checked: now };
      ws.setAttachment(next);
      if (agents.length !== current.agents.length || agents.some(agent => !current.agents.includes(agent))) this.advertise(ws);
      if (sync) this.selected(next)?.send(json({ type: 'joined' }));
    } finally { this.authing.delete(ws); this.presence(); }
  }

  private async authenticate(ws: ChatSocket, a: Extract<ChatAttachment, { role: 'pending' }>, raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { msg = {}; }
    const fail = (reason: string) => this.close(ws, CHAT_CLOSE.auth, reason);
    if (!msg || typeof msg.auth !== 'string' || (msg.role !== 'agent' && msg.role !== 'person')) return fail('The first message must be { auth, role }.');
    const board = BigInt(a.board);
    const at = this.deps.now();
    if (msg.role === 'agent') {
      const session = msg.session === undefined ? undefined : sessionDescriptor(msg.session);
      if (session === null) return fail('This conversation descriptor is invalid.');
      const claims = await this.deps.verifyAgent(msg.auth);
      if (this.ended.has(ws)) return;
      if (this.deps.now() - a.at >= CHAT_AUTH_MS) return fail('Authentication took too long. Open chat again.');
      if (!claims || claims.board !== board) return fail('This chat token is not valid for this board. Ask your agent for a new one (start_chat).');
      const next: Agent = { role: 'agent', board: a.board, at, agent: claims.agent, strikes: 0, ...(session ? { session } : {}) };
      const id = descriptor(next).id;
      const existing = this.online().find(s => s.session.id === id);
      if (existing && existing.attachment.agent !== claims.agent) return fail('This conversation id is already in use.');
      if (existing) this.close(existing.socket, CHAT_CLOSE.replaced, 'A newer chat helper took over.');
      ws.setAttachment(next);
      ws.send(json({ ok: true, role: 'agent' }));
      this.announce(claims.agent);
      this.presence();
      return;
    }
    const agents = await this.deps.linkedAgents(msg.auth, board);
    if (this.ended.has(ws)) return;
    if (this.deps.now() - a.at >= CHAT_AUTH_MS) return fail('Authentication took too long. Open chat again.');
    if (agents === null) return fail('You cannot read this board.');
    if (agents.length === 0) return fail('Only the person running an agent can chat with it. Link your agent first.');
    ws.setAttachment({ role: 'person', board: a.board, at, agents, checked: at, selected: null });
    ws.send(json({ ok: true, role: 'person' }));
    this.advertise(ws);
    const person = ws.attachment() as Person;
    this.selected(person)?.send(json({ type: 'joined' }));
    this.presence();
  }

  closed(ws: ChatSocket): void {
    const a = ws.attachment();
    const alreadyEnded = this.ended.has(ws);
    this.ended.add(ws);
    if (!alreadyEnded && a?.role === 'agent') this.announce(a.agent);
    if (!alreadyEnded && a?.role === 'person') this.presence();
  }

  sweep(): boolean {
    const now = this.deps.now();
    let waiting = false;
    for (const s of this.sockets()) {
      const a = s.attachment();
      if (a?.role !== 'pending' || this.ended.has(s)) continue;
      if (now - a.at >= CHAT_AUTH_MS) this.close(s, CHAT_CLOSE.auth, 'No authentication received.');
      else waiting = true;
    }
    return waiting;
  }
}

/** The 64 hex digits of an identity in any shape the database returns one (a row's JSON or a hex string). */
export function identityHex(value: unknown): string | undefined {
  return /(?:0x)?([0-9a-f]{64})/i.exec(JSON.stringify(value) ?? '')?.[1]?.toLowerCase();
}
