import { describe, it, expect, vi } from 'vitest';

vi.mock('./config', () => ({
  config: { spacetimeUri: 'ws://127.0.0.1:3100', spacetimeDb: 'redcrayon-test', canvasUrl: 'http://localhost:5173' },
}));

import { Timestamp } from 'spacetimedb';
import { identityFromClaims } from '$shared/identity';
import {
  accessFacets,
  accessLabel,
  ago,
  appHref,
  canvasHref,
  cardState,
  filterBoards,
  grantedAgents,
  idTail,
  isEpoch,
  isHostedAgent,
  linkedAgents,
  shareLink,
  sortBoards,
} from './boards';
import { DEMO, agentGrantRow, agentLink, myBoard } from './test-rows';

const ts = (micros: number) => new Timestamp(BigInt(micros));
const ACME = { id: 'org_1', name: 'Acme', role: 'org:member' };

describe('card derivations', () => {
  it('reads the Demo board as linked', () => {
    expect(cardState(DEMO)).toBe('linked');
  });
  it('session wins over linked; no repo files is a sketch', () => {
    expect(cardState(myBoard({ isSession: true, repoFiles: 3 }))).toBe('session');
    expect(cardState(myBoard())).toBe('sketch');
  });
  it('treats the epoch as unknown', () => {
    expect(isEpoch(Timestamp.UNIX_EPOCH)).toBe(true);
    expect(isEpoch(ts(1))).toBe(false);
  });
});

describe('ago', () => {
  const now = Date.UTC(2026, 9, 5, 12);
  it.each([
    [0, 'just now'],
    [59_000, 'just now'],
    [4 * 60_000, '4m ago'],
    [3 * 3_600_000, '3h ago'],
    [2 * 86_400_000, '2d ago'],
    [-5_000, 'just now'],
  ])('%i ms ago reads %s', (ms, text) => {
    expect(ago(new Date(now - ms), now)).toBe(text);
  });
});

describe('idTail', () => {
  it('shows the last 8 hex behind an ellipsis', () => {
    expect(idTail(`c200${'0'.repeat(52)}1a2b3c4d`)).toBe('…1a2b3c4d');
  });
});

describe('canvasHref', () => {
  const slug = 'c4bb879c7355360696d9';
  it('links the board by its slug, forwarding any non-default db', () => {
    expect(canvasHref(slug)).toBe(`http://localhost:5173/?db=redcrayon-test#b=${slug}`);
    // this deployment's own database (VITE_SPACETIME_DB, 'vitest' here) stays out of the link
    expect(canvasHref(slug, 'vitest', 'https://canvas.example.com')).toBe(`https://canvas.example.com/#b=${slug}`);
    expect(canvasHref(slug, 'redcrayon', 'https://canvas.example.com')).toBe(`https://canvas.example.com/?db=redcrayon#b=${slug}`);
  });
  it('never falls back to ?boardId= for a board without a slug', () => {
    expect(() => canvasHref('')).toThrow();
  });
});

describe('appHref', () => {
  it('keeps a ?db= override on in-app links so a reload stays on that database', () => {
    expect(appHref('/profile')).toBe('/profile?db=redcrayon-test'); // the mocked config differs from VITE_SPACETIME_DB
    expect(appHref('/profile', 'vitest')).toBe('/profile'); // the build's default database: no param
    expect(appHref('/dashboard?workspace=2')).toBe('/dashboard?workspace=2&db=redcrayon-test');
  });
});

describe('facets, filter, sort', () => {
  const rows = [
    myBoard({ boardId: 1n, name: 'Demo', access: 'public', updatedAt: ts(1) }),
    myBoard({ boardId: 2n, name: 'payments', access: 'owner', updatedAt: ts(5) }),
    myBoard({ boardId: 3n, name: 'infra', access: 'team', orgId: 'org_1', updatedAt: ts(3) }),
    myBoard({ boardId: 4n, name: 'session-main', access: 'agent', updatedAt: ts(5) }),
    myBoard({ boardId: 5n, name: 'interview', access: 'link', linkMode: 'edit', linkToken: 'ab'.repeat(16), updatedAt: ts(2) }),
  ];

  it('lists All, then each access kind and team that has boards', () => {
    expect(accessFacets(rows, [ACME])).toEqual([
      { key: 'all', label: 'All', count: 5 },
      { key: 'owner', label: 'Mine', count: 1 },
      { key: 'team:org_1', label: 'Acme', count: 1 },
      { key: 'link', label: 'Shared with you', count: 1 },
      { key: 'agent', label: 'Agents', count: 1 },
      { key: 'public', label: 'Public', count: 1 },
    ]);
    expect(accessFacets([rows[1]], [ACME]).map((f) => f.key)).toEqual(['all', 'owner']);
  });

  it('labels badges, naming unknown teams honestly', () => {
    expect(accessLabel(rows[2], [ACME])).toBe('Acme');
    expect(accessLabel(rows[2], [])).toBe('team');
    expect(accessLabel(rows[1], [ACME])).toBe('owner');
    expect(accessLabel(rows[4], [ACME])).toBe('can edit');
    expect(accessLabel({ ...rows[4], linkMode: 'view' }, [ACME])).toBe('view only');
  });

  it('filters by facet and case-insensitive name', () => {
    expect(filterBoards(rows, '', 'team:org_1').map((b) => b.name)).toEqual(['infra']);
    expect(filterBoards(rows, 'PAY').map((b) => b.name)).toEqual(['payments']);
    expect(filterBoards(rows, 'pay', 'public')).toEqual([]);
  });

  it('builds the share link on the canvas with the token in the fragment', () => {
    expect(shareLink('ab'.repeat(16), 'redcrayon-test', 'http://localhost:5173')).toBe(`http://localhost:5173/?db=redcrayon-test#s=${'ab'.repeat(16)}`);
  });

  it('sorts recent by updatedAt desc (ties: newest id first) or by name, without mutating', () => {
    const before = rows.map((b) => b.boardId);
    expect(sortBoards(rows, 'recent').map((b) => b.boardId)).toEqual([4n, 2n, 3n, 5n, 1n]);
    expect(sortBoards(rows, 'name').map((b) => b.name)).toEqual(['Demo', 'infra', 'interview', 'payments', 'session-main']);
    expect(rows.map((b) => b.boardId)).toEqual(before);
  });
});

describe('agent links', () => {
  it('keeps only links the caller owns', () => {
    const me = 'aa'.repeat(32);
    const agent = 'bb'.repeat(32);
    const links = [agentLink(agent, me), agentLink(me, 'cc'.repeat(32))];
    expect(linkedAgents(links, me).map((l) => l.agent.toHexString())).toEqual([agent]);
  });
});

describe('isHostedAgent', () => {
  // The hosted MCP links its agent again on the next call, so unlink cannot hold for it.
  it("knows the hosted MCP's agent for this user, and nothing without an MCP URL", () => {
    const hosted = identityFromClaims('https://mcp.example.com/agent-id', 'agent:user_1');
    expect(isHostedAgent(hosted, 'https://mcp.example.com/mcp', 'user_1')).toBe(true);
    expect(isHostedAgent('bb'.repeat(32), 'https://mcp.example.com/mcp', 'user_1')).toBe(false);
    expect(isHostedAgent(hosted, 'https://mcp.example.com/mcp', 'user_2')).toBe(false);
    expect(isHostedAgent(hosted, undefined, 'user_1')).toBe(false);
    expect(isHostedAgent(hosted, 'https://mcp.example.com/mcp', undefined)).toBe(false);
  });
});

describe('grantedAgents', () => {
  it('lists the agents that hold a grant on one board', () => {
    const grants = [
      agentGrantRow(1n, 5n, 'aa'.repeat(32)),
      agentGrantRow(2n, 5n, 'bb'.repeat(32)),
      agentGrantRow(3n, 6n, 'cc'.repeat(32)),
    ];
    expect(grantedAgents(grants, 5n)).toEqual(['aa'.repeat(32), 'bb'.repeat(32)]);
    expect(grantedAgents(grants, 9n)).toEqual([]);
  });
});
