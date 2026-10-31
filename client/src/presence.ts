import type { Node, Cursor, Selection, Participant } from './module_bindings/types';
import { el, nodeRect } from './render';

// Cursor/selection chrome colors — UI affordances keyed to identity, distinct
// from the board's semantic tokens.
const PALETTE = ['#2563EB', '#0D9488', '#9333EA', '#DB2777', '#D97706', '#475569'];

export function identityColor(hex: string): string {
  let h = 0;
  for (let i = 0; i < hex.length; i++) {
    h = (h * 31 + hex.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

/** D17: a hosted agent is active up to 2 min after its last call, dimmed to 30 min, then gone. */
export const AGENT_ACTIVE_MS = 2 * 60_000;
export const AGENT_SHOWN_MS = 30 * 60_000;

/**
 * Hosted agents call over HTTP and hold no socket (`connections: 0`), so their
 * last call (`lastSeenAt`) says whether they are here. A row with a live
 * socket is active whatever it is.
 */
export function presenceOf(p: Participant, now: number): 'active' | 'idle' | 'gone' {
  if (p.connections > 0) return 'active';
  if (p.kind !== 'agent') return 'gone';
  const age = now - p.lastSeenAt.toDate().getTime();
  return age <= AGENT_ACTIVE_MS ? 'active' : age <= AGENT_SHOWN_MS ? 'idle' : 'gone';
}

/**
 * Who is on this board (G47): online rows with a cursor or a selection here,
 * plus the local identity. The participant table has no board column, so
 * presence rows are the only board signal; an agent drawing on another board
 * stays off this one.
 */
export function participantsOnBoard(s: {
  participants: Participant[];
  cursors: Iterable<Cursor>;
  selections: Iterable<Selection>;
  myIdentityHex: string;
  boardId: bigint;
  now: number;
}): Participant[] {
  const here = new Set<string>([s.myIdentityHex]);
  for (const row of [...s.cursors, ...s.selections]) {
    if (row.boardId === s.boardId) {
      here.add(row.identity.toHexString());
    }
  }
  return s.participants.filter(p => presenceOf(p, s.now) !== 'gone' && here.has(p.identity.toHexString()));
}

/**
 * Whether a deleted cursor or selection row is this identity's and this tab
 * should write it back. The module clears an identity's cursor and selection on
 * every disconnect (dashboard spec D6): another tab or the dashboard of the
 * same identity closing, and every dashboard HTTP call as the same account
 * (/api/activity, every 30 s). Without a row on this board, everyone else stops
 * listing this tab. `have`: this tab has something to write (a selection, a
 * pointer position).
 */
export function ownPresenceLost(row: { identity: { toHexString(): string } }, myIdentityHex: string, have: boolean): boolean {
  return have && row.identity.toHexString() === myIdentityHex;
}

export interface PresenceState {
  nodes: Node[];
  cursors: Cursor[];
  selections: Selection[];
  participants: Participant[];
  myIdentityHex: string;
  boardId: bigint;
  scale: number;
}

export function renderPresence(layer: SVGGElement, s: PresenceState, now = Date.now()): void {
  layer.replaceChildren();
  const names = new Map(s.participants.filter(p => presenceOf(p, now) !== 'gone').map(p => [p.identity.toHexString(), p.displayName]));
  const nodesById = new Map(s.nodes.map(n => [n.id, n]));
  const inv = 1 / s.scale;

  // Remote selections: colored dashed outline offset 6px outside the node.
  for (const sel of s.selections) {
    const hex = sel.identity.toHexString();
    if (hex === s.myIdentityHex || sel.boardId !== s.boardId || !names.has(hex)) {
      continue;
    }
    const color = identityColor(hex);
    for (const nodeId of sel.nodeIds) {
      const n = nodesById.get(nodeId);
      if (!n) {
        continue;
      }
      const r = nodeRect(n, new Map());
      layer.append(
        el('rect', {
          x: String(r.x - 6),
          y: String(r.y - 6),
          width: String(r.w + 12),
          height: String(r.h + 12),
          rx: '10',
          fill: 'none',
          stroke: color,
          'stroke-width': '1',
          'stroke-dasharray': '2 3',
          'vector-effect': 'non-scaling-stroke',
          'pointer-events': 'none',
        })
      );
    }
  }

  // Remote cursors with name tags, constant screen size.
  for (const c of s.cursors) {
    const hex = c.identity.toHexString();
    if (hex === s.myIdentityHex || c.boardId !== s.boardId || !names.has(hex)) {
      continue;
    }
    const color = identityColor(hex);
    const name = names.get(hex) ?? hex.slice(0, 6);
    const g = el('g', {
      transform: `translate(${c.x} ${c.y}) scale(${inv})`,
      'pointer-events': 'none',
    });
    g.append(
      el('path', {
        d: 'M 0 0 L 12 10.5 L 7 11.5 L 9.5 17.5 L 7.5 18.5 L 5 12.5 L 1 16 Z',
        fill: color,
        stroke: '#FFFFFF',
        'stroke-width': '1',
      })
    );
    const tagW = name.length * 6.6 + 12;
    g.append(
      el('rect', {
        x: '14',
        y: '18',
        width: String(tagW),
        height: '18',
        rx: '4',
        fill: color,
      })
    );
    const label = el('text', {
      x: '20',
      y: '31',
      fill: '#FFFFFF',
      'font-family': "'Geist Mono', monospace",
      'font-size': '11',
    });
    label.textContent = name;
    g.append(label);
    layer.append(g);
  }
}

/**
 * Rate-limited presence writer: at most one write per `minMs`, and writes are
 * dropped — never queued — while the previous one hasn't landed.
 */
export function rateLimited(minMs: number): (fn: () => Promise<void>) => void {
  let last = 0;
  let inflight = false;
  return fn => {
    const now = performance.now();
    if (inflight || now - last < minMs) {
      return;
    }
    last = now;
    inflight = true;
    void fn().finally(() => {
      inflight = false;
    });
  };
}

/**
 * Latest-wins sender for low-rate state (selection): coalesces bursts to one
 * write per `minMs` but always delivers the most recent value eventually.
 */
export function latestWins(minMs: number): (fn: () => Promise<void>) => void {
  let pending: (() => Promise<void>) | null = null;
  let timer: number | null = null;
  let inflight = false;
  const flush = () => {
    timer = null;
    if (inflight || !pending) {
      return;
    }
    const fn = pending;
    pending = null;
    inflight = true;
    void fn().finally(() => {
      inflight = false;
      if (pending && timer === null) {
        timer = window.setTimeout(flush, minMs);
      }
    });
  };
  return fn => {
    pending = fn;
    if (timer === null && !inflight) {
      timer = window.setTimeout(flush, 0);
    }
  };
}
