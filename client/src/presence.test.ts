import { describe, it, expect } from 'vitest';
import type { Cursor, Node, Participant, Selection } from './module_bindings/types';
import { AGENT_ACTIVE_MS, AGENT_SHOWN_MS, ownPresenceLost, participantsOnBoard, presenceOf, renderPresence } from './presence';

const NOW = Date.UTC(2026, 9, 10, 12);
const id = (hex: string) => ({ toHexString: () => hex }) as unknown as Participant['identity'];
const at = (ms: number) => ({ toDate: () => new Date(ms) }) as unknown as Participant['lastSeenAt'];
const person = (hex: string, kind = 'human', connections = 1, lastSeen = 0) =>
  ({ identity: id(hex), displayName: `${kind}-${hex}`, kind, connections, lastSeenAt: at(lastSeen) }) as unknown as Participant;
/** A hosted agent: it calls over HTTP and never holds a socket. */
const hosted = (hex: string, ageMs: number) => person(hex, 'agent', 0, NOW - ageMs);
const cursor = (hex: string, boardId: bigint) => ({ identity: id(hex), boardId, x: 0, y: 0 }) as unknown as Cursor;
const selection = (hex: string, boardId: bigint) => ({ identity: id(hex), boardId, nodeIds: [] }) as unknown as Selection;

describe('participantsOnBoard (G47)', () => {
  it('participant with presence only on another board is hidden', () => {
    const shown = participantsOnBoard({
      participants: [person('me'), person('agent', 'agent'), person('cur'), person('sel'), person('idle')],
      cursors: [cursor('agent', 2n), cursor('cur', 1n)],
      selections: [selection('agent', 2n), selection('sel', 1n)],
      myIdentityHex: 'me',
      boardId: 1n,
      now: NOW,
    });
    expect(shown.map(p => p.identity.toHexString())).toEqual(['me', 'cur', 'sel']);
  });

  it('the local identity shows before it has a cursor; offline rows never show', () => {
    const shown = participantsOnBoard({
      participants: [person('me'), person('gone', 'human', 0, NOW)],
      cursors: [cursor('gone', 1n)],
      selections: [],
      myIdentityHex: 'me',
      boardId: 1n,
      now: NOW,
    });
    expect(shown.map(p => p.identity.toHexString())).toEqual(['me']);
  });
});

describe('hosted agents (connections 0, D17)', () => {
  it('expires retained selections and cursors on repaint, and restores them after another call', () => {
    const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const participant = hosted('bot', 0);
    const state = {
      nodes: [{ id: 1n, x: 0, y: 0, w: 160, h: 64 } as Node],
      participants: [participant], cursors: [cursor('bot', 1n)],
      selections: [{ ...selection('bot', 1n), nodeIds: [1n] }],
      myIdentityHex: 'me', boardId: 1n, scale: 1,
    };
    renderPresence(layer, state, NOW);
    expect(layer.children).toHaveLength(2);
    renderPresence(layer, state, NOW + AGENT_SHOWN_MS);
    expect(layer.children).toHaveLength(2);
    renderPresence(layer, state, NOW + AGENT_SHOWN_MS + 1);
    expect(layer.children).toHaveLength(0);
    participant.lastSeenAt = at(NOW + AGENT_SHOWN_MS + 2);
    renderPresence(layer, state, NOW + AGENT_SHOWN_MS + 2);
    expect(layer.children).toHaveLength(2);
    participant.connections = 1;
    renderPresence(layer, state, NOW + 2 * AGENT_SHOWN_MS + 3);
    expect(layer.children).toHaveLength(2);
  });

  it('are active up to 2 min after their last call, dimmed to 30 min, then gone', () => {
    expect(AGENT_ACTIVE_MS).toBe(120_000);
    expect(AGENT_SHOWN_MS).toBe(1_800_000);
    expect(presenceOf(hosted('a', 0), NOW)).toBe('active');
    expect(presenceOf(hosted('a', 2 * 60_000), NOW)).toBe('active');
    expect(presenceOf(hosted('a', 2 * 60_000 + 1), NOW)).toBe('idle');
    expect(presenceOf(hosted('a', 30 * 60_000), NOW)).toBe('idle');
    expect(presenceOf(hosted('a', 30 * 60_000 + 1), NOW)).toBe('gone');
  });

  it('a socket means active whatever the last call; a human without one is gone', () => {
    expect(presenceOf(person('a', 'agent', 1, 0), NOW)).toBe('active');
    expect(presenceOf(person('h', 'human', 0, NOW), NOW)).toBe('gone');
  });

  it('show on the board they select on until D17 hides them', () => {
    const on = (ageMs: number) =>
      participantsOnBoard({
        participants: [person('me'), hosted('bot', ageMs)],
        cursors: [],
        selections: [selection('bot', 1n)],
        myIdentityHex: 'me',
        boardId: 1n,
        now: NOW,
      }).map(p => p.identity.toHexString());
    expect(on(1_000)).toEqual(['me', 'bot']);
    expect(on(12 * 60_000)).toEqual(['me', 'bot']);
    expect(on(31 * 60_000)).toEqual(['me']);
  });
});

describe('ownPresenceLost (dashboard spec D6)', () => {
  it('only the own deleted row, and only when this tab has something to write back', () => {
    expect(ownPresenceLost(cursor('me', 1n), 'me', true)).toBe(true);
    expect(ownPresenceLost(selection('me', 1n), 'me', false)).toBe(false); // nothing selected, or no pointer yet
    expect(ownPresenceLost(selection('other', 1n), 'me', true)).toBe(false);
  });
});
