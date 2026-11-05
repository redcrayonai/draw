/**
 * One board's agent chat: the person running an agent talks to it from the
 * canvas. A helper connects as `agent` with a start_chat token; a browser
 * connects as `person`, and hears from and speaks to only the agents its own
 * token shows it linked (my_agent_links). Nothing here is stored: the queue and
 * the history live in the helper, on the person's machine.
 *
 * Plain logic over a socket interface, like live.ts; the Chat DO in worker.ts
 * only adapts hibernatable WebSockets to it.
 */

export type ChatAttachment =
  | { role: 'pending'; board: string; at: number }
  | { role: 'agent'; board: string; at: number; agent: string; strikes: number }
  | { role: 'person'; board: string; at: number; agents: string[]; checked: number };

export interface ChatSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
  attachment(): ChatAttachment | null;
  setAttachment(a: ChatAttachment): void;
}

export interface ChatDeps {
  /** The agent identity and board of a start_chat token, or null when it is not valid. */
  verifyAgent(token: string): Promise<{ agent: string; board: bigint } | null>;
  /** The agents this canvas token linked, or null when it cannot read the board. */
  linkedAgents(token: string, board: bigint): Promise<string[] | null>;
  now(): number;
}

export const CHAT_AUTH_MS = 10_000;
/** What a person may type in one message. */
export const CHAT_MAX_BYTES = 64 * 1024;
/** The helper's frames carry history: a whole conversation fits (helper/src/chat.ts keeps inside this). */
export const CHAT_MAX_AGENT_BYTES = 1024 * 1024;
export const CHAT_MAX_STRIKES = 20;
export const CHAT_REAUTH_MS = 30_000;
const ACCESS_TTL_MS = 3 * CHAT_REAUTH_MS;

export const CHAT_CLOSE = { auth: 4001, replaced: 4009, abuse: 4008 } as const;

/** What a person may ask of their agent; every other frame is dropped. */
const PERSON_TYPES = new Set(['send', 'delete', 'stop', 'resume']);

const json = (v: unknown) => JSON.stringify(v);

export class ChatHub {
  private authing = new WeakSet<ChatSocket>();

  constructor(private deps: ChatDeps, private sockets: () => ChatSocket[]) {}

  private agentSocket(agent: string, except?: ChatSocket): ChatSocket | undefined {
    return this.sockets().find(s => {
      const a = s.attachment();
      return s !== except && a?.role === 'agent' && a.agent === agent;
    });
  }

  private people(agent: string, except?: ChatSocket): ChatSocket[] {
    return this.sockets().filter(s => {
      const a = s.attachment();
      return s !== except && a?.role === 'person' && a.agents.includes(agent);
    });
  }

  async message(ws: ChatSocket, raw: string): Promise<void> {
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
    if (raw.length > (a.role === 'agent' ? CHAT_MAX_AGENT_BYTES : CHAT_MAX_BYTES)) {
      if (a.role !== 'agent') return ws.close(CHAT_CLOSE.abuse, 'That message is too long to send.');
      const strikes = a.strikes + 1;
      ws.setAttachment({ ...a, strikes });
      if (strikes >= CHAT_MAX_STRIKES) ws.close(CHAT_CLOSE.abuse, 'The agent sent too many oversized messages; it was disconnected.');
      return;
    }
    if (a.role === 'agent') {
      for (const p of this.people(a.agent)) this.toPerson(p, raw);
      return;
    }
    let msg: { type?: unknown; auth?: unknown; sync?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.auth === 'string') return this.recheck(ws, a, msg.auth, msg.sync === true);
    if (typeof msg.type !== 'string' || !PERSON_TYPES.has(msg.type)) return;
    if (this.deps.now() - a.checked > ACCESS_TTL_MS) return ws.close(CHAT_CLOSE.auth, 'Chat could not re-check your access. Open it again.');
    for (const agent of a.agents) this.agentSocket(agent)?.send(raw);
  }

  private toPerson(p: ChatSocket, raw: string): void {
    const a = p.attachment();
    if (a?.role !== 'person') return;
    if (this.deps.now() - a.checked > ACCESS_TTL_MS) p.close(CHAT_CLOSE.auth, 'Chat could not re-check your access. Open it again.');
    else p.send(raw);
  }

  /**
   * A person's periodic token: the socket keeps only the links it still has, and closes when it has none.
   * `sync` asks the helper for the talk so far: an agent connected while this socket sat idle.
   */
  private async recheck(ws: ChatSocket, a: Extract<ChatAttachment, { role: 'person' }>, token: string, sync: boolean): Promise<void> {
    const now = this.deps.now();
    const join = (agents: string[]) => {
      if (sync) for (const agent of agents) this.agentSocket(agent)?.send(json({ type: 'joined' }));
    };
    if (this.authing.has(ws)) return;
    if (now - a.checked < CHAT_REAUTH_MS / 2) return join(a.agents);
    this.authing.add(ws);
    try {
      const agents = await this.deps.linkedAgents(token, BigInt(a.board));
      if (!agents?.length) return ws.close(CHAT_CLOSE.auth, 'You can no longer chat with an agent on this board.');
      const current = ws.attachment();
      if (current?.role === 'person') ws.setAttachment({ ...current, agents, checked: now });
      join(agents);
    } finally {
      this.authing.delete(ws);
    }
  }

  private async authenticate(ws: ChatSocket, a: Extract<ChatAttachment, { role: 'pending' }>, raw: string): Promise<void> {
    let msg: { auth?: unknown; role?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      msg = {};
    }
    const fail = (reason: string) => ws.close(CHAT_CLOSE.auth, reason);
    if (typeof msg.auth !== 'string' || (msg.role !== 'agent' && msg.role !== 'person')) return fail('The first message must be { auth, role }.');
    const board = BigInt(a.board);
    const at = this.deps.now();
    if (msg.role === 'agent') {
      const claims = await this.deps.verifyAgent(msg.auth);
      if (!claims || claims.board !== board) return fail('This chat token is not valid for this board. Ask your agent for a new one (start_chat).');
      // Monitors re-arm: the newest helper of this agent takes over.
      this.agentSocket(claims.agent, ws)?.close(CHAT_CLOSE.replaced, 'A newer chat helper took over.');
      ws.setAttachment({ role: 'agent', board: a.board, at, agent: claims.agent, strikes: 0 });
      ws.send(json({ ok: true, role: 'agent' }));
      // Status only, so an idle socket may hear it before its next re-check; it answers with a fresh token and sync.
      for (const p of this.people(claims.agent, ws)) p.send(json({ agent: 'connected' }));
      return;
    }
    const agents = await this.deps.linkedAgents(msg.auth, board);
    if (agents === null) return fail('You cannot read this board.');
    if (agents.length === 0) return fail('Only the person running an agent can chat with it. Link your agent first.');
    ws.setAttachment({ role: 'person', board: a.board, at, agents, checked: at });
    const online = agents.filter(agent => this.agentSocket(agent));
    ws.send(json({ ok: true, role: 'person' }));
    ws.send(json({ agent: online.length ? 'connected' : 'gone' }));
    // The history lives in the helper: it answers a join with a snapshot.
    for (const agent of online) this.agentSocket(agent)?.send(json({ type: 'joined' }));
  }

  closed(ws: ChatSocket): void {
    const a = ws.attachment();
    if (a?.role !== 'agent' || this.agentSocket(a.agent, ws)) return;
    for (const p of this.people(a.agent, ws)) p.send(json({ agent: 'gone' }));
  }

  /** Close connections that never authenticated; returns whether any are still waiting. */
  sweep(): boolean {
    const now = this.deps.now();
    let waiting = false;
    for (const s of this.sockets()) {
      const a = s.attachment();
      if (a?.role !== 'pending') continue;
      if (now - a.at >= CHAT_AUTH_MS) s.close(CHAT_CLOSE.auth, 'No authentication received.');
      else waiting = true;
    }
    return waiting;
  }
}

/** The 64 hex digits of an identity in any shape the database returns one (a row's JSON or a hex string). */
export function identityHex(value: unknown): string | undefined {
  return /(?:0x)?([0-9a-f]{64})/i.exec(JSON.stringify(value) ?? '')?.[1]?.toLowerCase();
}
