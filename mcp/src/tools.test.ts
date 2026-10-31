import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DbError } from '../../shared/db-http';
import { identityFromClaims } from '../../shared/identity';
import { scrub } from './scrub';
import { TEXT_DENYLIST } from './copy';
import { layoutUnits, planLayout } from './layout-apply';
import { shareHref } from '../../shared/share-link';
import { INSTRUCTIONS, TOOLS, TOOL_NAMES, boardInLink } from './tools';
import { verifyMarks, verifyTap } from './issuer';
import { testEnv } from './test/env';
import type { LiveStatus } from './live';
import { ICON_IDS } from '../../module/src/node-icons';
import { CODE_CONSENT_RULE, boardStoresCode, markCheckpointFlow, prepareSourceEvidence, startSessionFlow } from '../../agent/src/session';
import { arriveFlow } from '../../agent/src/routes';
import { claim } from './captures';

// create_edge's capture, source line and consent are stood in for; the rest of both modules is real.
vi.mock('./captures', async importOriginal => {
  const actual = await importOriginal<typeof import('./captures')>();
  return { ...actual, claim: vi.fn(actual.claim) };
});
vi.mock('../../agent/src/session', async importOriginal => {
  const actual = await importOriginal<typeof import('../../agent/src/session')>();
  return {
    ...actual,
    prepareSourceEvidence: vi.fn(actual.prepareSourceEvidence),
    boardStoresCode: vi.fn(actual.boardStoresCode),
    markCheckpointFlow: vi.fn(actual.markCheckpointFlow),
    startSessionFlow: vi.fn(actual.startSessionFlow),
  };
});
vi.mock('../../agent/src/routes', async importOriginal => {
  const actual = await importOriginal<typeof import('../../agent/src/routes')>();
  return { ...actual, arriveFlow: vi.fn(actual.arriveFlow) };
});

const VENDOR = /spacetime|maincloud|bsatn|clockwork|\bstdb\b/i;
const HOSTED = [
  'get_board', 'create_node', 'move_node', 'update_node', 'resize_node', 'delete_node', 'create_edge', 'hide_node', 'hide_edge', 'set_edge_latency', 'play_trace', 'start_tap', 'tap_status', 'create_branch', 'submit_branch',
  'delete_edge', 'describe_charts', 'create_chart', 'set_chart_data', 'get_chart', 'start_session', 'add_code_ref',
  'mark_checkpoint', 'plan_route', 'arrive', 'reroute', 'remove_code_ref', 'set_node_doc', 'set_selection', 'layout_board',
  'add_change_note', 'update_change_note', 'remove_change_note',
  'add_threat', 'update_threat', 'remove_threat',
  'wait_for_marks', 'watch_marks', 'reply_to_mark', 'list_marks',
];
const keysOf = (schema: z.ZodType): string[] => {
  const json = z.toJSONSchema(schema) as { properties?: Record<string, unknown> };
  return Object.keys(json.properties ?? {});
};

describe('boardInLink', () => {
  const o = { app: 'https://draw.example.com' } as Parameters<typeof boardInLink>[0];
  it('reads a #b= slug or a ?boardId= id from this deployment, never SQL text', () => {
    expect(boardInLink(o, 'https://draw.example.com/#b=c4bb879c7355360696d9', 'redcrayon')).toBe('c4bb879c7355360696d9');
    expect(boardInLink(o, 'https://draw.example.com/?db=x&boardId=42', 'x')).toBe(42n);
    expect(boardInLink(o, "https://draw.example.com/#b=x'%20OR%20'1'='1", 'redcrayon')).toBeUndefined();
    expect(boardInLink(o, 'https://other.example.com/#b=c4bb879c7355360696d9', 'redcrayon')).toBeUndefined();
  });

  it('rejects links to another database even when its origin and board ID match', () => {
    expect(boardInLink(o, 'https://draw.example.com/?db=redcrayon-staging&boardId=42', 'redcrayon')).toBeUndefined();
    // a link with no ?db= names this deployment's own database, whatever its name
    expect(boardInLink(o, 'https://draw.example.com/?boardId=42', 'redcrayon-staging')).toBe(42n);
    expect(boardInLink(o, 'https://draw.example.com/?db=other#b=c4bb879c7355360696d9', 'redcrayon-staging')).toBeUndefined();
    expect(boardInLink(o, 'https://draw.example.com/?db=redcrayon&boardId=42', 'redcrayon')).toBe(42n);
    expect(boardInLink(o, 'https://draw.example.com/?db=redcrayon-staging#b=c4bb879c7355360696d9', 'redcrayon-staging')).toBe('c4bb879c7355360696d9');
  });

  it('reads the token of a Share link', () => {
    const token = '0123456789abcdef0123456789abcdef';
    expect(boardInLink(o, shareHref('https://draw.example.com/?boardId=7', 'redcrayon', token), 'redcrayon')).toEqual({ share: token });
    expect(boardInLink(o, "https://draw.example.com/#s=x'", 'redcrayon')).toBeUndefined();
    const staging = shareHref('https://draw.example.com/', 'redcrayon-staging', token);
    expect(boardInLink(o, staging, 'redcrayon-staging')).toEqual({ share: token });
    expect(boardInLink(o, staging, 'redcrayon')).toBeUndefined();
  });

  it('reads a bare slug or id, as the canvas shows them', () => {
    expect(boardInLink(o, 'c4bb879c7355360696d9', 'redcrayon')).toBe('c4bb879c7355360696d9');
    expect(boardInLink(o, '4133', 'redcrayon')).toBe(4133n);
    expect(boardInLink(o, '12345678901234567890', 'redcrayon')).toBe('12345678901234567890');
    expect(boardInLink(o, "x' OR '1'='1", 'redcrayon')).toBeUndefined();
  });

  it('reads a bare #b= or #s= fragment as this deployment', () => {
    expect(boardInLink(o, '#b=c4bb879c7355360696d9', 'redcrayon')).toBe('c4bb879c7355360696d9');
    expect(boardInLink(o, '#b=12345678901234567890', 'redcrayon')).toBe('12345678901234567890');
    expect(boardInLink(o, '#s=0123456789abcdef0123456789abcdef', 'redcrayon')).toEqual({ share: '0123456789abcdef0123456789abcdef' });
    expect(boardInLink(o, "#b=x'%20OR%20'1'='1", 'redcrayon')).toBeUndefined();
  });
});

describe('the hosted tool list (spec §4)', () => {
  it("is today's stdio tools minus link_dashboard", () => {
    expect([...TOOL_NAMES].sort()).toEqual([...HOSTED].sort());
  });

  it('every tool but start_session and describe_charts takes board', () => {
    for (const [name, def] of Object.entries(TOOLS)) {
      expect(keysOf(def.input).includes('board'), name).toBe(name !== 'start_session' && name !== 'describe_charts');
    }
  });

  it('no input carries code-bearing fields: the server reads code, the model never types it', () => {
    for (const [name, def] of Object.entries(TOOLS)) {
      expect(keysOf(def.input).filter(k => /^(snippet|content|text|bytes|sha|blobSha|head|coverage)$/.test(k)), name).toEqual([]);
    }
  });

  it('refuses unknown keys before any write', () => {
    expect(TOOLS.move_node.input.safeParse({ board: '1', nodeId: '2', x: 0, y: 0, force: true }).success).toBe(false);
  });

  it('titles, scopes and annotations', () => {
    for (const def of Object.values(TOOLS)) expect(def.title.length).toBeGreaterThan(0);
    expect(Object.entries(TOOLS).filter(([, d]) => d.scope === 'board:read').map(([n]) => n).sort()).toEqual(['describe_charts', 'get_board', 'get_chart', 'list_marks', 'tap_status']);
    expect(Object.entries(TOOLS).filter(([, d]) => d.annotations?.destructiveHint).map(([n]) => n).sort()).toEqual(['delete_edge', 'delete_node', 'remove_change_note', 'remove_code_ref', 'remove_threat']);
    expect(TOOLS.get_board.annotations?.readOnlyHint).toBe(true);
  });

  it('capture is optional on the tools that read the checkout, with the exact description', () => {
    const withCapture = Object.entries(TOOLS).filter(([, d]) => keysOf(d.input).includes('capture')).map(([n]) => n).sort();
    expect(withCapture).toEqual(['add_code_ref', 'arrive', 'create_edge', 'mark_checkpoint', 'start_session']);
    const json = z.toJSONSchema(TOOLS.add_code_ref.input) as { properties: Record<string, { description?: string }> };
    expect(json.properties.capture.description).toBe(
      'Leave empty when the redcrayon plugin is installed; it fills this in. Otherwise run npx -y @redcrayonai/draw@1 capture … in the project and pass the id it prints.'
    );
  });

  it('descriptions and instructions name no vendor, no env vars and no internals', () => {
    const texts = [INSTRUCTIONS, ...Object.values(TOOLS).map(d => d.description)];
    for (const t of texts) {
      expect(t).not.toMatch(VENDOR);
      expect(t).not.toMatch(TEXT_DENYLIST);
      expect(t).not.toMatch(/REPO_PATH|CLAUDE_PROJECT_DIR|\bforce\b|active board/);
    }
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(2000);
    expect(INSTRUCTIONS).toContain('add_change_note');
    expect(INSTRUCTIONS).toContain('add_threat');
  });
});

type Node = { id: bigint; boardId: bigint; kind: string; x: number; y: number; w: number; h: number; hidden: boolean };

/** One board in memory: reads by view, and move_node / resize_node write back, so a second layout sees the first. */
function fakeBoard(nodes: Node[], edges: Record<string, unknown>[] = [], onCall: (n: number) => Promise<void> = async () => {}) {
  const calls: { reducer: string; args: Record<string, any> }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const db = {
    stats: { dbCalls: 0, dbMs: 0, writes: 0 },
    async read(q: { text: string }) {
      if (q.text.includes('visible_board')) return [{ id: 1n, name: 'main' }];
      if (q.text.includes('visible_node')) return nodes;
      if (q.text.includes('visible_edge')) return edges;
      throw new Error(`unexpected read ${q.text}`);
    },
    async call(reducer: string, args: Record<string, any>) {
      calls.push({ reducer, args });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await onCall(calls.length);
        const n = nodes.find(n => n.id === args.nodeId)!;
        Object.assign(n, reducer === 'move_node' ? { x: args.x, y: args.y } : { x: args.x, y: args.y, w: args.w, h: args.h });
        db.stats.writes += 1;
      } finally {
        inFlight -= 1;
      }
    },
  };
  const t = (deadline = Date.now() + 15_000) => ({ ctx: { db }, signal: new AbortController().signal, named: () => {}, deadline }) as never;
  return { calls, t, max: () => maxInFlight };
}

const pile = (count: number): Node[] =>
  Array.from({ length: count }, (_, i) => ({ id: BigInt(i + 1), boardId: 1n, kind: 'service', x: 0, y: 0, w: 160, h: 64, hidden: false }));
const text = (r: { content: { text: string }[] }) => r.content[0].text;

describe('layout_board on the hosted server', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the stdio description and board:write, with no hints', () => {
    expect(TOOLS.layout_board.description).toBe(
      'Lay out the board left to right: entry points left, data stores right, members kept inside their containers, room left for edge labels. Moves nodes and resizes containers (boundaries, and any non-chart node drawn around others) to fit their members; hidden nodes stay where they are; other node sizes do not change. Call it after a pass that added nodes or edges, before mark_checkpoint; skip it when a person has arranged the board. Returns "committed layout: moved <n>, resized <m> board=<name>".'
    );
    expect(TOOLS.layout_board.scope).toBe(TOOLS.move_node.scope);
    expect(TOOLS.layout_board.annotations).toBeUndefined();
    expect(TOOLS.layout_board.input.safeParse({ board: '1' }).success).toBe(true);
  });

  it('applies the plan through move_node and resize_node, at most 6 writes at a time, then has nothing left to do', async () => {
    const nodes = [...pile(12), { id: 20n, boardId: 1n, kind: 'boundary', x: -400, y: -400, w: 1600, h: 1600, hidden: false }];
    const edges = [{ id: 30n, boardId: 1n, fromNode: 1n, toNode: 2n, label: 'calls', hidden: false }];
    const tick = () => new Promise<void>(r => setTimeout(r, 1));
    const b = fakeBoard(nodes, edges, tick);
    const first = text(await TOOLS.layout_board.run({ board: '1' }, b.t()));
    const moves = b.calls.filter(c => c.reducer === 'move_node').length;
    const resizes = b.calls.filter(c => c.reducer === 'resize_node').length;
    expect(first).toBe(`committed layout: moved ${moves}, resized ${resizes} board=main`);
    expect(moves).toBeGreaterThan(6);
    expect(resizes).toBe(1);
    expect(b.calls.map(c => c.reducer).lastIndexOf('move_node')).toBeLessThan(b.calls.findIndex(c => c.reducer === 'resize_node'));
    expect(b.calls.every(c => [c.args.x, c.args.y, c.args.w ?? 0, c.args.h ?? 0].every(v => v % 4 === 0))).toBe(true);
    expect(b.max()).toBe(6);
    const again = b.calls.length;
    expect(text(await TOOLS.layout_board.run({ board: '1' }, b.t()))).toBe('committed layout: already laid out board=main');
    expect(b.calls.length).toBe(again);
  });

  it('stops issuing writes when the 15 s budget runs short, and says to call again', async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const b = fakeBoard(pile(20), [], async () => {
      clock += 1000;
    });
    const out = text(await TOOLS.layout_board.run({ board: '1' }, b.t(clock + 15_000)));
    // 6 writes go out at once (the clock reads +6 s), then one more per lane until 9 s: the last write still has its 5 s and 1 s to answer.
    expect(b.calls.length).toBe(9);
    expect(out).toMatch(/^committed layout: moved 9 of (\d+), resized 0 of 0; call again to continue board=main$/);
    expect(Number(out.match(/of (\d+)/)![1])).toBeGreaterThan(9);
  });

  it('never leaves a unit half-applied when the budget cuts off mid-plan', async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // three boundaries of 5 members each, side by side, members piled up: 3 units of 6 writes, plus 4 free nodes
    const nodes: Node[] = [];
    for (const k of [0, 1, 2]) {
      nodes.push({ id: BigInt(100 + k), boardId: 1n, kind: 'boundary', x: k * 2000, y: 0, w: 1600, h: 1600, hidden: false });
      for (let i = 0; i < 5; i++) nodes.push({ id: BigInt(10 * k + i + 1), boardId: 1n, kind: 'service', x: k * 2000 + 40, y: 80, w: 160, h: 64, hidden: false });
    }
    for (let i = 0; i < 4; i++) nodes.push({ id: BigInt(200 + i), boardId: 1n, kind: 'service', x: 8000, y: 0, w: 160, h: 64, hidden: false });
    const toLayout = (ns: Node[]) => ns.map(({ boardId, ...n }) => ({ ...n }));
    const units = layoutUnits(toLayout(nodes), await planLayout(toLayout(nodes), []));
    expect(units.length).toBeGreaterThan(3);
    const b = fakeBoard(nodes, [], async () => {
      clock += 1000;
    });
    const out = text(await TOOLS.layout_board.run({ board: '1' }, b.t(clock + 15_000)));
    expect(out).toMatch(/; call again to continue board=main$/);
    const written = new Set(b.calls.map(c => `${c.reducer} ${c.args.nodeId}`));
    const keys = (u: (typeof units)[number]) => [...u.moves.map(m => `move_node ${m.id}`), ...u.resizes.map(r => `resize_node ${r.id}`)];
    const applied = units.filter(u => keys(u).every(k => written.has(k)));
    for (const u of units) expect(keys(u).every(k => written.has(k)) || keys(u).every(k => !written.has(k))).toBe(true);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.length).toBeLessThan(units.length);
    const [, a, A, bb, B] = out.match(/moved (\d+) of (\d+), resized (\d+) of (\d+)/)!.map(Number);
    expect([a, bb]).toEqual([applied.reduce((n, u) => n + u.moves.length, 0), applied.reduce((n, u) => n + u.resizes.length, 0)]);
    expect([A, B]).toEqual([units.reduce((n, u) => n + u.moves.length, 0), units.reduce((n, u) => n + u.resizes.length, 0)]);
  });

  it('applies one unit even when reading and planning already passed the cut-off', async () => {
    const b = fakeBoard(pile(20));
    const out = text(await TOOLS.layout_board.run({ board: '1' }, b.t(Date.now() - 60_000)));
    expect(b.calls.length).toBe(1);
    expect(out).toMatch(/^committed layout: moved 1 of \d+, resized 0 of 0; call again to continue board=main$/);
  });

  it('stops issuing writes after a failure and throws it once the writes in flight settle', async () => {
    const b = fakeBoard(pile(20), [], async n => {
      if (n === 2) throw new DbError(530, 'move rule: no');
      await new Promise(r => setTimeout(r, 1));
    });
    await expect(TOOLS.layout_board.run({ board: '1' }, b.t())).rejects.toBeInstanceOf(DbError);
    // a module refusal is not retried, and no lane picks up new work after it
    expect(b.calls.length).toBe(6);
  });
});

describe('set_edge_latency on the hosted server', () => {
  const run = async (input: Record<string, unknown>) => {
    const calls: { reducer: string; args: Record<string, any> }[] = [];
    const db = {
      stats: { dbCalls: 0, dbMs: 0, writes: 0 },
      async read(q: { text: string }) {
        if (q.text.includes('visible_board')) return [{ id: 1n, name: 'main' }];
        if (q.text.includes('visible_edge')) return [{ id: 30n, boardId: 1n }];
        throw new Error(`unexpected read ${q.text}`);
      },
      async call(reducer: string, args: Record<string, any>) {
        calls.push({ reducer, args });
      },
    };
    const t = { ctx: { db }, signal: new AbortController().signal, named: () => {}, deadline: Date.now() + 15_000 } as never;
    const out = text(await TOOLS.set_edge_latency.run(TOOLS.set_edge_latency.input.parse(input) as never, t));
    return { calls, out };
  };

  it('writes the latency and its source; a clear sends no source', async () => {
    expect(await run({ board: '1', edgeId: '30', latencyMs: 38.5, source: 'prod' })).toEqual({
      calls: [{ reducer: 'set_edge_latency', args: { edgeId: 30n, latencyMs: 38.5, source: 'prod' } }],
      out: 'committed board=main',
    });
    expect((await run({ board: '1', edgeId: '30', latencyMs: -1 })).calls[0].args).toEqual({ edgeId: 30n, latencyMs: -1, source: '' });
  });

  it('accepts only prod, local or estimate as a source', () => {
    expect(TOOLS.set_edge_latency.input.safeParse({ board: '1', edgeId: '30', latencyMs: 5, source: 'guess' }).success).toBe(false);
  });
});

describe('icons on the hosted create_node and update_node', () => {
  const harness = (iconRows: Record<string, unknown>[] = []) => {
    const calls: { reducer: string; args: Record<string, any> }[] = [];
    const node = { id: 5n, boardId: 1n, label: 'Planner', sublabel: '', x: 0, y: 0, w: 160, h: 96, kind: 'service' };
    const db = {
      stats: { dbCalls: 0, dbMs: 0, writes: 0 },
      async read(q: { text: string }) {
        if (q.text.includes('visible_board')) return [{ id: 1n, name: 'main' }];
        if (q.text.includes('visible_node_icon')) return iconRows;
        if (q.text.includes('visible_node')) return calls.length ? [node] : q.text.includes('WHERE id') ? [node] : [];
        if (q.text.includes('visible_code_ref')) return [];
        throw new Error(`unexpected read ${q.text}`);
      },
      async call(reducer: string, args: Record<string, any>) {
        calls.push({ reducer, args });
      },
    };
    const ledger = { claim: async () => ({ first: true }), settle: async () => {} };
    const t = { ctx: { db, ledger }, signal: new AbortController().signal, named: () => {}, deadline: Date.now() + 15_000 } as never;
    return { calls, t };
  };

  it('create_node with an icon writes through create_icon_node, node and icon in one call', async () => {
    const { calls, t } = harness();
    const input = { board: '1', label: 'Planner', sublabel: '', x: 0, y: 0, w: 160, h: 96, token: 'ink', focal: false, icon: 'agent' };
    expect(text(await TOOLS.create_node.run(TOOLS.create_node.input.parse(input) as never, t))).toBe('committed id=5 board=main');
    expect(calls.map(c => c.reducer)).toEqual(['create_icon_node']);
    expect(calls[0].args).toMatchObject({ boardId: 1n, label: 'Planner', icon: 'agent' });
  });

  it('create_node without an icon still calls create_node', async () => {
    const { calls, t } = harness();
    const input = { board: '1', label: 'Planner', sublabel: '', x: 0, y: 0, w: 160, h: 96, token: 'ink', focal: false };
    await TOOLS.create_node.run(TOOLS.create_node.input.parse(input) as never, t);
    expect(calls.map(c => c.reducer)).toEqual(['create_node']);
    expect('icon' in calls[0].args).toBe(false);
  });

  it('the fit hint makes room for the icon: 160x64 is too short for an icon and a label', async () => {
    const { t } = harness();
    const input = { board: '1', label: 'Planner', sublabel: 'agent', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false, icon: 'agent' };
    expect(text(await TOOLS.create_node.run(TOOLS.create_node.input.parse(input) as never, t))).toMatch(/needs h=\d+ to show label and sublabel/);
    const plain = { ...input, icon: undefined };
    expect(text(await TOOLS.create_node.run(TOOLS.create_node.input.parse(plain) as never, harness().t))).not.toMatch(/needs h=/);
  });

  it('update_node sets, replaces or removes an icon through set_node_icon, after any other field', async () => {
    let h = harness();
    await TOOLS.update_node.run(TOOLS.update_node.input.parse({ board: '1', nodeId: '5', icon: 'model' }) as never, h.t);
    expect(h.calls).toEqual([{ reducer: 'set_node_icon', args: { nodeId: 5n, icon: 'model' } }]);
    h = harness();
    await TOOLS.update_node.run(TOOLS.update_node.input.parse({ board: '1', nodeId: '5', kind: 'external', icon: '' }) as never, h.t);
    expect(h.calls.map(c => c.reducer)).toEqual(['update_node', 'set_node_icon']);
    expect(h.calls[1].args).toEqual({ nodeId: 5n, icon: '' });
    h = harness();
    await TOOLS.update_node.run(TOOLS.update_node.input.parse({ board: '1', nodeId: '5', label: 'Lead' }) as never, h.t);
    expect(h.calls.map(c => c.reducer)).toEqual(['update_node']);
  });

  it('the descriptions list every library icon id by section', () => {
    for (const name of ['create_node', 'update_node'] as const) {
      for (const id of ICON_IDS) {
        expect(TOOLS[name].description, `${name} ${id}`).toContain(id);
      }
    }
  });
});

describe('add_threat on the hosted server', () => {
  it('flags a node on a board with no session (a claude.ai agent has no checkout)', async () => {
    const calls: { reducer: string; args: Record<string, any> }[] = [];
    const db = {
      stats: { dbCalls: 0, dbMs: 0, writes: 0 },
      async read(q: { text: string }) {
        if (q.text.includes('visible_board')) return [{ id: 1n, name: 'main' }];
        if (q.text.includes('visible_session')) return [];
        if (q.text.includes('visible_node')) return [{ id: 2n }];
        if (q.text.includes('visible_threat')) return calls.length ? [{ id: 9n, boardId: 1n, anchorId: 2n, title: 'CVE-1' }] : [];
        throw new Error(`unexpected read ${q.text}`);
      },
      async call(reducer: string, args: Record<string, any>) {
        calls.push({ reducer, args });
      },
    };
    const ledger = { claim: async () => ({ first: true }), settle: async () => {} };
    const t = { ctx: { db, ledger }, signal: new AbortController().signal, named: () => {}, deadline: Date.now() + 15_000 } as never;
    const input = { board: '1', anchorId: '2', stage: 'compromised', severity: 'high', title: 'CVE-1', summary: 'x', author: 'claude' };
    const out = text(await TOOLS.add_threat.run(TOOLS.add_threat.input.parse(input) as never, t));
    expect(out).toBe('committed id=9 board=main');
    expect(calls.map(c => [c.reducer, c.args.boardId, c.args.anchorId, c.args.author])).toEqual([['add_threat', 1n, 2n, 'claude']]);
  });

  it('refuses an anchor that is not on the board before any call', async () => {
    const db = {
      stats: { dbCalls: 0, dbMs: 0, writes: 0 },
      async read(q: { text: string }) {
        if (q.text.includes('visible_board')) return [{ id: 1n, name: 'main' }];
        if (q.text.includes('visible_node')) return [{ id: 3n }];
        throw new Error(`unexpected read ${q.text}`);
      },
      async call() {
        throw new Error('no call expected');
      },
    };
    const t = { ctx: { db }, signal: new AbortController().signal, named: () => {}, deadline: Date.now() + 15_000 } as never;
    const input = { board: '1', anchorId: '2', stage: 'vulnerable', severity: 'low', title: 'CVE-1', summary: 'x' };
    await expect(TOOLS.add_threat.run(TOOLS.add_threat.input.parse(input) as never, t)).rejects.toThrow(/node 2/);
  });

  it('caps cvss, package, fixedIn and author like the module does', () => {
    const base = { board: '1', anchorId: '2', stage: 'vulnerable', severity: 'low', title: 'CVE-1', summary: 'x' };
    const ok = (extra: Record<string, string>) => TOOLS.add_threat.input.safeParse({ ...base, ...extra }).success;
    expect(ok({ cvss: 'x'.repeat(8), package: 'x'.repeat(120), fixedIn: 'x'.repeat(40), author: 'x'.repeat(80) })).toBe(true);
    for (const [k, n] of [['cvss', 9], ['package', 121], ['fixedIn', 41], ['author', 81]] as const) expect(ok({ [k]: 'x'.repeat(n) }), k).toBe(false);
  });
});

describe('play_trace on the hosted server', () => {
  const run = async (input: Record<string, unknown>) => {
    const calls: { reducer: string; args: Record<string, any> }[] = [];
    const db = {
      stats: { dbCalls: 0, dbMs: 0, writes: 0 },
      async read(q: { text: string }) {
        if (q.text.includes('visible_board')) return [{ id: 1n, name: 'main' }];
        throw new Error(`unexpected read ${q.text}`);
      },
      async call(reducer: string, args: Record<string, any>) {
        calls.push({ reducer, args });
      },
    };
    const t = { ctx: { db }, signal: new AbortController().signal, named: () => {}, deadline: Date.now() + 15_000 } as never;
    const out = text(await TOOLS.play_trace.run(TOOLS.play_trace.input.parse(input) as never, t));
    return { calls, out };
  };
  const spans = [
    { id: 'a', node: '1', startMs: 0, durationMs: 120 },
    { id: 'b', parent: 'a', node: '2', startMs: 10, durationMs: 140.4, status: 'error' },
  ];

  it('sends the spans as JSON with the source and title, and reports count and length', async () => {
    const { calls, out } = await run({ board: '1', spans, source: 'local', title: 'GET /' });
    expect(calls).toEqual([{ reducer: 'play_trace', args: { boardId: 1n, spans: JSON.stringify(spans), source: 'local', title: 'GET /' } }]);
    expect(out).toBe('committed trace: 2 spans, 150ms board=main');
  });

  it('refuses span fields outside the whitelist before any call', () => {
    const bad = { board: '1', source: 'prod', spans: [{ ...spans[0], attributes: { url: 'https://x' } }] };
    expect(TOOLS.play_trace.input.safeParse(bad).success).toBe(false);
  });
});

describe('start_tap and watch_marks on the hosted server', () => {
  const run = async (access: string, tool: 'start_tap' | 'watch_marks' = 'start_tap', keyId?: string) => {
    const env = await testEnv();
    const db = {
      stats: { dbCalls: 0, dbMs: 0, writes: 0 },
      async read(q: { text: string }) {
        if (q.text.includes('visible_board')) return [{ id: 5n, name: 'main' }];
        if (q.text.includes('my_boards')) return [{ boardId: 5n, access }];
        throw new Error(`unexpected read ${q.text}`);
      },
      async call() {
        throw new Error(`${tool} writes nothing`);
      },
    };
    const t = { ctx: { db, env, principal: { userId: 'user_ada', ...(keyId ? { machine: { keyId } } : {}) } }, signal: new AbortController().signal, named: () => {}, deadline: Date.now() + 15_000 } as never;
    return { env, out: TOOLS[tool].run({ board: '5', seat: 'AbCdEfGhIjKlMnOp' } as never, t) };
  };

  it('gives a writer a 12-hour token for this board and the command to run', async () => {
    const { env, out } = await run('owner');
    const body = JSON.parse(text(await out));
    expect(body).toMatchObject({ board: '5', otlp: 'http://127.0.0.1:4318', expires_in_hours: 12 });
    expect(body.command).toBe(`npx -y @redcrayonai/draw@1 tap --token ${body.token}`);
    expect(await verifyTap(env, body.token)).toMatchObject({ sub: 'agent:user_ada', board: 5n });
  });

  it('refuses a board the agent can only read', async () => {
    const { out } = await run('public');
    await expect(out).rejects.toThrow(/cannot edit this board/);
  });

  it('refuses managed-key taps because derived publish tokens cannot be revoked immediately', async () => {
    await expect((await run('grant', 'start_tap', 'a'.repeat(32))).out).rejects.toThrow(/service accounts cannot start a live tap/);
  });

  it('watch_marks gives a writer a 12-hour marks token for this board and seat, and the command to run', async () => {
    const { env, out } = await run('agent', 'watch_marks');
    const body = JSON.parse(text(await out));
    expect(body).toMatchObject({ board: '5', expires_in_hours: 12 });
    expect(body.command).toBe(`npx -y @redcrayonai/draw@1 marks --token ${body.token}`);
    expect(await verifyMarks(env, body.token)).toEqual({ sub: 'agent:user_ada', board: 5n, seat: 'AbCdEfGhIjKlMnOp' });
    expect(await verifyTap(env, body.token)).toBeNull();
  });

  it('watch_marks refuses a board the agent can only read', async () => {
    await expect((await run('public', 'watch_marks')).out).rejects.toThrow(/cannot watch for marks on it/);
  });

  it('keeps marks helper tokens bound to the individual managed key', async () => {
    const keyId = 'a'.repeat(32);
    const { env, out } = await run('grant', 'watch_marks', keyId);
    const body = JSON.parse(text(await out));
    expect(await verifyMarks(env, body.token)).toEqual({ sub: `machine:${keyId}`, board: 5n, seat: 'AbCdEfGhIjKlMnOp' });
  });
});

describe('tap_status', () => {
  const run = async (status: LiveStatus | null) => {
    const ids: string[] = [];
    const LIVE = status && { idFromName: (n: string) => (ids.push(n), n), get: () => ({ status: async () => status }) };
    const env = await testEnv(LIVE ? { LIVE: LIVE as never } : {});
    const db = {
      stats: { dbCalls: 0, dbMs: 0, writes: 0 },
      async read(q: { text: string }) {
        if (q.text.includes('visible_board')) return [{ id: 5n, name: 'main' }];
        throw new Error(`unexpected read ${q.text}`);
      },
      async call() {
        throw new Error('tap_status writes nothing');
      },
    };
    const t = { ctx: { db, env, principal: { userId: 'user_ada' } }, signal: new AbortController().signal, named: () => {}, deadline: Date.now() + 15_000 } as never;
    return { ids, body: JSON.parse(text(await TOOLS.tap_status.run({ board: '5' }, t))) };
  };

  it('reports the connected tap, when it last sent, and that you started it', async () => {
    const { ids, body } = await run({ tap: true, since: Date.UTC(2026, 9, 31, 10), lastPublish: Date.UTC(2026, 9, 31, 10, 5), sub: 'agent:user_ada', watching: true });
    expect(ids).toEqual(['5']);
    expect(body).toEqual({ board: '5', tap: 'connected', connected_since: '2026-10-31T10:00:00.000Z', last_sent: '2026-10-31T10:05:00.000Z', watching: true, started_by_you: true });
  });

  it('says when someone else started it, and cannot tell for a tap from before that was recorded', async () => {
    expect((await run({ tap: true, since: 0, lastPublish: null, sub: 'agent:user_bob', watching: false })).body.started_by_you).toBe(false);
    expect((await run({ tap: true, since: 0, lastPublish: null, sub: null, watching: false })).body.started_by_you).toBeNull();
  });

  it('reports none without a tap, and without a live channel', async () => {
    const none = { board: '5', tap: 'none', connected_since: null, last_sent: null, watching: false, started_by_you: null };
    expect((await run({ tap: false, since: null, lastPublish: null, sub: null, watching: true })).body).toEqual({ ...none, watching: true });
    expect((await run(null)).body).toEqual(none);
  });
});


describe('red crayon review marks', () => {
  const HEX = identityFromClaims('https://iss.test', 'agent:u1');
  const SEAT = 'AbCdEfGhIjKlMnOp';
  const mark = (id: bigint, nodeId: bigint, extra: Record<string, unknown> = {}) => ({
    id, boardId: 1n, nodeId, nodeLabel: `n${nodeId}`, note: `fix ${id}`, round: 1, status: 'claimed', claimedBy: `${HEX}/${SEAT}`, claimGen: 3, reply: '', files: '[]', ...extra,
  });
  function harness(opts: { byId?: Record<string, any>[]; marks?: Record<string, any>[]; claimed?: Record<string, any>[]; deadline?: number; fail?: Error } = {}) {
    const calls: { reducer: string; args: Record<string, any> }[] = [];
    const reads: string[] = [];
    const db = {
      stats: { dbCalls: 0, dbMs: 0, writes: 0 },
      async read(q: { text: string }) {
        reads.push(q.text);
        if (q.text.includes('visible_board')) return [{ id: 1n, name: 'main' }];
        if (q.text.includes('visible_mark') && q.text.includes('WHERE id =')) return (opts.byId ?? [{ id: 7n, boardId: 1n }]).filter(m => q.text.endsWith(`= ${m.id}`));
        if (q.text.includes('visible_mark')) return q.text.includes('claimed_by') ? opts.claimed ?? [] : opts.marks ?? [];
        if (q.text.includes('visible_node')) return [{ id: 10n, doc: 'doc ten' }, { id: 11n, doc: '' }];
        if (q.text.includes('visible_code_ref')) {
          return [
            { targetKind: 'node', targetId: 10n, path: 'src/a.ts', symbol: 'a', startLine: 1, endLine: 5 },
            { targetKind: 'node', targetId: 11n, path: 'src/a.ts', symbol: 'b', startLine: 7, endLine: 9 },
            { targetKind: 'edge', targetId: 10n, path: 'src/zzz.ts', symbol: 'e', startLine: 1, endLine: 1 },
          ];
        }
        throw new Error(`unexpected read ${q.text}`);
      },
      async call(reducer: string, args: Record<string, any>) {
        calls.push({ reducer, args });
        if (opts.fail) throw opts.fail;
      },
    };
    const ctx = { db, o: { issuer: 'https://iss.test' }, principal: { userId: 'u1' } };
    const t = { ctx, signal: new AbortController().signal, named: () => {}, deadline: opts.deadline ?? Date.now() + 15_000 } as never;
    return { calls, reads, t };
  }

  it('wait_for_marks claims, reads this seat back and groups by shared file', async () => {
    const h = harness({ claimed: [mark(2n, 11n), mark(1n, 10n), mark(3n, 12n, { claimGen: 1 })] });
    const out = JSON.parse(text(await TOOLS.wait_for_marks.run(TOOLS.wait_for_marks.input.parse({ board: '1', seat: SEAT }) as never, h.t)));
    expect(h.calls).toEqual([{ reducer: 'claim_marks', args: { boardId: 1n, seat: SEAT } }]);
    expect(h.reads.find(r => r.includes('claimed_by'))).toContain(`claimed_by = '${HEX}/${SEAT}'`);
    expect(out.board).toBe('main');
    expect(out.groups).toHaveLength(2);
    expect(out.groups[0].files).toEqual(['src/a.ts']);
    expect(out.groups[0].marks.map((m: any) => m.mark)).toEqual(['1', '2']);
    expect(out.groups[0].marks[0]).toMatchObject({ mark: '1', claimGen: 3, node: '10', note: 'fix 1', doc: 'doc ten', refs: [{ path: 'src/a.ts', symbol: 'a', startLine: 1, endLine: 5 }] });
    expect(out.groups[1]).toMatchObject({ files: [], marks: [{ mark: '3', claimGen: 1, doc: '', refs: [] }] });
  });

  it('wait_for_marks answers "no marks yet" at once when the deadline is near', async () => {
    const h = harness({ deadline: Date.now() + 4500 });
    const started = Date.now();
    const out = text(await TOOLS.wait_for_marks.run(TOOLS.wait_for_marks.input.parse({ board: '1', seat: SEAT }) as never, h.t));
    expect(out).toBe('no marks yet; call wait_for_marks again with the same seat');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(h.calls).toHaveLength(1);
  });

  it('wait_for_marks refuses a seat that is not 16 alphanumerics', () => {
    expect(TOOLS.wait_for_marks.input.safeParse({ board: '1', seat: 'short' }).success).toBe(false);
  });

  it('reply_to_mark calls reply_mark with every field', async () => {
    const h = harness();
    const input = { board: '1', seat: SEAT, mark: '7', claimGen: 3, status: 'fixed', reply: 'done', files: ['src/a.ts'] };
    expect(text(await TOOLS.reply_to_mark.run(TOOLS.reply_to_mark.input.parse(input) as never, h.t))).toBe('committed board=main');
    expect(h.calls).toEqual([{ reducer: 'reply_mark', args: { markId: 7n, seat: SEAT, claimGen: 3, status: 'fixed', reply: 'done', files: ['src/a.ts'] } }]);
    expect(TOOLS.reply_to_mark.input.safeParse({ ...input, status: 'sent' }).success).toBe(false);
  });

  it('reply_to_mark refuses a mark on another board, or one it cannot see, without calling reply_mark', async () => {
    const input = TOOLS.reply_to_mark.input.parse({ board: '1', seat: SEAT, mark: '7', claimGen: 3, status: 'fixed', reply: 'done', files: [] });
    for (const byId of [[{ id: 7n, boardId: 2n }], []]) {
      const h = harness({ byId });
      const err = await TOOLS.reply_to_mark.run(input as never, h.t).catch(e => e);
      expect(scrub(err, { write: true, board: 'main' }).text).toBe('REJECTED: mark 7 is not on this board board=main');
      expect(h.calls).toEqual([]);
    }
  });

  it('a reclaimed mark surfaces as the module sentence', async () => {
    const h = harness({ fail: new DbError(530, 'mark was reclaimed by another agent; drop it') });
    const input = TOOLS.reply_to_mark.input.parse({ board: '1', seat: SEAT, mark: '7', claimGen: 3, status: 'kept', reply: 'x', files: [] });
    const err = await TOOLS.reply_to_mark.run(input as never, h.t).catch(e => e);
    expect(scrub(err, { write: true, board: 'main' }).text).toBe('REJECTED: mark was reclaimed by another agent; drop it board=main');
  });

  it('a mark held by another seat of the same agent surfaces as the module sentence', async () => {
    const h = harness({ fail: new DbError(530, 'this mark is held by another seat of yours; use the seat that claimed it') });
    const input = TOOLS.reply_to_mark.input.parse({ board: '1', seat: SEAT, mark: '7', claimGen: 3, status: 'kept', reply: 'x', files: [] });
    const err = await TOOLS.reply_to_mark.run(input as never, h.t).catch(e => e);
    expect(scrub(err, { write: true, board: 'main' }).text).toBe('REJECTED: this mark is held by another seat of yours; use the seat that claimed it board=main');
  });

  it('list_marks returns every mark, or only one round', async () => {
    const marks = [mark(1n, 10n, { round: 1, status: 'fixed', reply: 'ok', files: '["src/a.ts"]' }), mark(2n, 11n, { round: 2, status: 'sent', claimedBy: '' })];
    const h = harness({ marks });
    const all = JSON.parse(text(await TOOLS.list_marks.run(TOOLS.list_marks.input.parse({ board: '1' }) as never, h.t)));
    expect(all.marks.map((m: any) => [m.mark, m.round, m.status])).toEqual([['1', 1, 'fixed'], ['2', 2, 'sent']]);
    expect(all.marks[0]).toMatchObject({ reply: 'ok', files: ['src/a.ts'], note: 'fix 1' });
    const two = JSON.parse(text(await TOOLS.list_marks.run(TOOLS.list_marks.input.parse({ board: '1', round: 2 }) as never, h.t)));
    expect(two.marks.map((m: any) => m.mark)).toEqual(['2']);
  });
});

describe('create_edge on the hosted server: the cited line stays out unless the board stores code (RC-690)', () => {
  const HASH = 'ab'.repeat(16);
  const LINE = 'const limiter = new Limiter();';
  const run = async (stores: boolean, turnedOff = false) => {
    vi.mocked(claim).mockResolvedValue({ kind: 'cite', toplevel: '/repo', head: 'h', file: { path: 'src/s.ts' }, asked: 'src/s.ts' } as never);
    vi.mocked(prepareSourceEvidence).mockResolvedValue({ evidence: 'source:src/s.ts:1', evidenceSnippet: LINE, evidenceHash: HASH });
    vi.mocked(boardStoresCode).mockResolvedValue(stores);
    const calls: { reducer: string; args: Record<string, any> }[] = [];
    const edges: Record<string, unknown>[] = [];
    let refuse = turnedOff;
    const db = {
      stats: { dbCalls: 0, dbMs: 0, writes: 0 },
      http: {},
      token: async () => 'tok',
      async read(q: { text: string }) {
        if (q.text.includes('visible_session')) return [{ boardId: 1n, baseSha: 'h', repoRoot: '/repo' }];
        if (q.text.includes('visible_board')) return [{ id: 1n, name: 'main' }];
        if (q.text.includes('visible_node')) return [{ id: 1n }, { id: 2n }];
        if (q.text.includes('visible_edge')) return edges;
        throw new Error(`unexpected read ${q.text}`);
      },
      async call(reducer: string, args: Record<string, any>) {
        calls.push({ reducer, args });
        if (reducer === 'create_edge' && args.evidenceSnippet && refuse) {
          refuse = false;
          throw new DbError(530, CODE_CONSENT_RULE);
        }
        if (reducer === 'create_edge') edges.push({ id: 77n, boardId: 1n, fromNode: args.fromNode, toNode: args.toNode, label: args.label, evidence: args.evidence });
      },
    };
    const ledger = { claim: async () => ({ first: true }), settle: async () => {} };
    const t = { ctx: { db, ledger }, signal: new AbortController().signal, named: () => {}, deadline: Date.now() + 15_000 } as never;
    const input = TOOLS.create_edge.input.parse({ board: '1', fromNode: '1', toNode: '2', label: 'uses', evidence: 'source:src/s.ts:1', capture: 'cap_' + 'A'.repeat(22) });
    const out = text(await TOOLS.create_edge.run(input as never, t));
    return { calls, out };
  };
  const edge = { boardId: 1n, fromNode: 1n, toNode: 2n, label: 'uses', evidence: 'source:src/s.ts:1' };

  it('without consent: the edge has no line, then the line hash', async () => {
    const { calls, out } = await run(false);
    expect(out).toBe('committed id=77 board=main');
    expect(calls).toEqual([
      { reducer: 'create_edge', args: { ...edge, evidenceSnippet: '', evidenceStatus: 'ok' } },
      { reducer: 'set_edge_evidence_code', args: { edgeId: 77n, lineHash: HASH } },
    ]);
    expect(JSON.stringify(calls, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(LINE);
  });

  it('with consent: the line goes in both calls', async () => {
    const { calls } = await run(true);
    expect(calls).toEqual([
      { reducer: 'create_edge', args: { ...edge, evidenceSnippet: LINE } },
      { reducer: 'set_edge_evidence_code', args: { edgeId: 77n, lineHash: HASH, snippet: LINE } },
    ]);
  });

  it('consent turned off since it was read: the same edge once more without the line', async () => {
    const { calls, out } = await run(true, true);
    expect(out).toBe('committed id=77 board=main');
    expect(calls).toEqual([
      { reducer: 'create_edge', args: { ...edge, evidenceSnippet: LINE } },
      { reducer: 'create_edge', args: { ...edge, evidenceSnippet: '', evidenceStatus: 'ok' } },
      { reducer: 'set_edge_evidence_code', args: { edgeId: 77n, lineHash: HASH } },
    ]);
  });
});

describe('the repo remote on the hosted server (RC-690)', () => {
  const HEAD = 'a'.repeat(40);
  const REMOTE = 'https://github.com/o/r.git';
  const CAP = 'cap_' + 'A'.repeat(22);
  type Body = Record<string, unknown>;

  // The flows are stood in for; what is under test is the set_session_remote call around them.
  const run = async (tool: 'mark_checkpoint' | 'arrive' | 'start_session', body: Body, opts: { remoteFails?: boolean } = {}) => {
    const order: string[] = [];
    const calls: { reducer: string; args: Record<string, any> }[] = [];
    vi.mocked(claim).mockResolvedValue({ toplevel: '/repo', head: HEAD, ...body } as never);
    vi.mocked(markCheckpointFlow).mockImplementation((async () => (order.push('flow'), { checkpoint: 2 })) as never);
    vi.mocked(arriveFlow).mockImplementation((async () => (order.push('flow'), { checkpoint: 2 })) as never);
    vi.mocked(startSessionFlow).mockImplementation((async () => (order.push('flow'), { boardId: 1n, checkpoint: 0, repoRoot: '/repo' })) as never);
    const db = {
      stats: { dbCalls: 0, dbMs: 0, writes: 0 },
      http: {},
      token: async () => 'tok',
      async read(q: { text: string }) {
        if (q.text.includes('visible_session')) return [{ boardId: 1n, baseSha: 'b'.repeat(40), repoRoot: '/repo', checkpoint: 0 }];
        if (q.text.includes('visible_board')) return [{ id: 1n, name: 'main', slug: 'main-slug' }];
        return []; // my_boards, visible_selection, visible_code_ref, visible_edge
      },
      async call(reducer: string, args: Record<string, any>) {
        calls.push({ reducer, args });
        if (reducer === 'set_session_remote') {
          order.push('remote');
          if (opts.remoteFails) throw new DbError(530, 'remote rule: remoteUrl must be one line');
        }
      },
    };
    const o = { issuer: 'https://mcp.example.com', idp: 'https://idp.example.com', app: 'https://draw.example.com', boardUrl: (slug: string) => `https://draw.example.com/#b=${slug}` };
    const ctx = { db, o, env: { DB_NAME: 'redcrayon' }, principal: { userId: 'user_ada' }, captures: {} };
    const t = { ctx, signal: new AbortController().signal, named: () => {}, deadline: Date.now() + 15_000 } as never;
    const input =
      tool === 'start_session'
        ? { name: 'main', capture: CAP }
        : tool === 'arrive'
          ? { board: '1', nodeId: '2', capture: CAP }
          : { board: '1', capture: CAP };
    const out = text(await TOOLS[tool].run(TOOLS[tool].input.parse(input) as never, t));
    return { order, out, remote: calls.filter(c => c.reducer === 'set_session_remote') };
  };
  const checkpoint = (over: Body = {}): Body => ({ kind: 'checkpoint', base: 'b'.repeat(40), files: [], uncompared: new Map(), hunks: new Map(), ...over });

  for (const tool of ['mark_checkpoint', 'arrive'] as const) {
    describe(tool, () => {
      it('records the remote, HEAD when it is pushed, and the dirty cited paths, after the checkpoint', async () => {
        const { order, remote } = await run(tool, checkpoint({ remote: REMOTE, pushed: true, dirty: ['src/a.ts'] }));
        expect(remote).toEqual([{ reducer: 'set_session_remote', args: { boardId: 1n, remoteUrl: REMOTE, pushedHead: HEAD, dirtyPaths: ['src/a.ts'] } }]);
        expect(order).toEqual(['flow', 'remote']);
      });

      it('records no pushed head when HEAD is not pushed, or the helper did not say', async () => {
        expect((await run(tool, checkpoint({ remote: REMOTE, pushed: false, dirty: [] }))).remote[0].args).toMatchObject({ pushedHead: '', dirtyPaths: [] });
        expect((await run(tool, checkpoint({ remote: REMOTE }))).remote[0].args).toMatchObject({ pushedHead: '', dirtyPaths: [] });
      });

      it('makes no call when the capture has no remote (a 1.0.x helper, or a remote that is not github.com)', async () => {
        const { remote, out } = await run(tool, checkpoint({ pushed: true, dirty: ['src/a.ts'] }));
        expect(remote).toEqual([]);
        expect(out).toContain('"checkpoint": 2');
      });

      it('still answers when the remote cannot be recorded: the checkpoint is already committed', async () => {
        const { remote, out } = await run(tool, checkpoint({ remote: REMOTE, pushed: true }), { remoteFails: true });
        expect(remote).toHaveLength(1);
        expect(out).toContain('"checkpoint": 2');
      });
    });
  }

  describe('start_session', () => {
    it('records the remote with no pushed head and no dirty paths', async () => {
      const { order, remote } = await run('start_session', { kind: 'start', remote: REMOTE });
      expect(remote).toEqual([{ reducer: 'set_session_remote', args: { boardId: 1n, remoteUrl: REMOTE, pushedHead: '', dirtyPaths: [] } }]);
      expect(order).toEqual(['flow', 'remote']);
    });

    it('makes no call without a remote', async () => {
      const { remote, out } = await run('start_session', { kind: 'start' });
      expect(remote).toEqual([]);
      expect(JSON.parse(out)).toMatchObject({ board: 'main', id: 1, session: true });
    });
  });
});
