import { describe, it, expect } from 'vitest';
import type { Chart, Edge, LibraryItem, Node } from './module_bindings/types';
import {
  ARCHITECTURE_CHART_RULE,
  CHART_CONTRACTS,
  CHART_MIN_H,
  CHART_MIN_W,
  CHART_TYPES,
  SAMPLE_SOURCE,
  parseChart,
} from '../../module/src/chart-contracts';
import { CHART_NOT_LOADED, buildLibraryPayload, iconNodePlacement, insertRefusal, parseLibraryPayload, samplePlacement, saveRefusal, type LibraryPayloadV1 } from './library';
import { ARCHITECTURE_ICON_RULE, ICON_NODE_H, ICON_NODE_W, ICONS } from '../../module/src/node-icons';

function mkNode(id: number, over: Partial<Node> = {}): Node {
  return {
    id: BigInt(id), boardId: 1n, label: `node-${id}`, sublabel: '', x: 0, y: 0, w: 160, h: 80,
    token: 'ink', focal: false, kind: 'service', doc: '', hidden: false, imported: false,
    shape: 'rect', color: '', strokeStyle: 'solid', size: 'm', sourceKey: '', ...over,
  };
}

function mkEdge(id: number, from: number, to: number, over: Partial<Edge> = {}): Edge {
  return {
    id: BigInt(id), boardId: 1n, fromNode: BigInt(from), toNode: BigInt(to), label: '', evidence: 'human:abc',
    evidenceSnippet: '', evidenceStatus: '', relation: '', color: '', strokeStyle: 'solid',
    hidden: false, imported: false, latencyMs: -1, latencySource: '', ...over,
  };
}

// Only the fields the library reads; updatedAt is irrelevant here.
const mkChart = (nodeId: bigint, over: Partial<Chart> = {}): Chart =>
  ({ nodeId, boardId: 1n, type: 'bars', csv: 'host,req\na,1\n', options: '{}', source: 'human:ana', ...over }) as unknown as Chart;

const noCharts = (): Chart | undefined => undefined;

describe('buildLibraryPayload', () => {
  it('stores coordinates relative to the group top-left, keys 0..n-1, and drops focal', () => {
    const payload = buildLibraryPayload(
      [
        mkNode(7, {
          x: 120, y: 200, focal: true, kind: 'datastore', shape: 'pill', color: 'blue', strokeStyle: 'dashed',
          size: 'l', token: 'accent', doc: 'orders', label: 'orders db', sublabel: 'pg', sourceKey: 'js:src/db.ts',
        }),
        mkNode(3, { x: 40, y: 260, hidden: false, imported: true }),
      ],
      [],
      noCharts
    );
    expect(payload.version).toBe(1);
    expect(payload.nodes).toEqual([
      {
        key: 0, label: 'orders db', sublabel: 'pg', x: 80, y: 0, w: 160, h: 80, token: 'accent', kind: 'datastore',
        doc: 'orders', shape: 'pill', color: 'blue', strokeStyle: 'dashed', size: 'l',
      },
      {
        key: 1, label: 'node-3', sublabel: '', x: 0, y: 60, w: 160, h: 80, token: 'ink', kind: 'service',
        doc: '', shape: 'rect', color: '', strokeStyle: 'solid', size: 'm',
      },
    ]);
    const text = JSON.stringify(payload);
    expect(text).not.toContain('focal');
    expect(text).not.toContain('sourceKey');
    expect(text).not.toContain('imported');
  });

  it('keeps only edges with both ends selected, without evidence', () => {
    const payload = buildLibraryPayload(
      [mkNode(1), mkNode(2, { x: 200 })],
      [
        mkEdge(10, 1, 2, { label: 'calls', color: 'red', strokeStyle: 'dashed', evidence: 'source:a.ts:4', relation: 'calls' }),
        mkEdge(11, 2, 3),
        mkEdge(12, 3, 1),
      ],
      noCharts
    );
    expect(payload.edges).toEqual([{ from: 0, to: 1, label: 'calls', color: 'red', strokeStyle: 'dashed' }]);
    expect(JSON.stringify(payload)).not.toContain('source:a.ts');
  });

  it('saves an edge weight other than regular, and nothing for a regular edge (RC-688)', () => {
    const weights = new Map([[10n, 'bold']]);
    const payload = buildLibraryPayload(
      [mkNode(1), mkNode(2, { x: 200 })],
      [mkEdge(10, 1, 2, { strokeStyle: 'dotted' }), mkEdge(11, 2, 1)],
      noCharts,
      id => weights.get(id) ?? 'regular'
    );
    expect(payload.edges).toEqual([
      { from: 0, to: 1, label: '', color: '', strokeStyle: 'dotted', weight: 'bold' },
      { from: 1, to: 0, label: '', color: '', strokeStyle: 'solid' },
    ]);
    const parsed = parseLibraryPayload(JSON.stringify(payload));
    expect(parsed.ok && parsed.payload.edges).toEqual(payload.edges);
  });

  it('copies chart rows and leaves out a chart whose row has not arrived', () => {
    const rows = new Map([
      [5n, mkChart(5n, { type: 'toplist', csv: 'route,p99\n/a,12\n', options: '{"limit":5}', source: 'agent: k6 @ 9f1c2ab' })],
    ]);
    const payload = buildLibraryPayload(
      [
        mkNode(5, { kind: 'chart', w: 352, h: 224 }),
        mkNode(6, { kind: 'chart', x: 400, w: 352, h: 224 }),
        mkNode(7, { y: 300 }),
      ],
      [mkEdge(20, 6, 7), mkEdge(21, 5, 7)],
      id => rows.get(id)
    );
    expect(payload.nodes.map(n => [n.key, n.label])).toEqual([[0, 'node-5'], [1, 'node-7']]);
    expect(payload.nodes[0].chart).toEqual({
      type: 'toplist', csv: 'route,p99\n/a,12\n', options: '{"limit":5}', source: 'agent: k6 @ 9f1c2ab',
    });
    expect(payload.nodes[1].chart).toBeUndefined();
    expect(payload.edges).toEqual([{ from: 0, to: 1, label: '', color: '', strokeStyle: 'solid' }]);
  });

  it('round-trips through parseLibraryPayload', () => {
    const rows = new Map([[5n, mkChart(5n)]]);
    const payload = buildLibraryPayload(
      [mkNode(5, { kind: 'chart', x: 8, y: 8, w: 352, h: 224 }), mkNode(9, { x: 400, y: 8 })],
      [mkEdge(30, 9, 5, { label: 'feeds' })],
      id => rows.get(id)
    );
    expect(parseLibraryPayload(JSON.stringify(payload))).toEqual({ ok: true, payload });
  });
});

describe('parseLibraryPayload', () => {
  const node0 = {
    key: 0, label: 'a', sublabel: '', x: 0, y: 0, w: 160, h: 80, token: 'ink', kind: 'service',
    doc: '', shape: 'rect', color: '', strokeStyle: 'solid', size: 'm',
  };
  const doc = (over: Record<string, unknown>) => JSON.stringify({ version: 1, nodes: [node0], edges: [], ...over });

  const CASES: [string, string, string][] = [
    ['text that is not JSON', '{"version":1,', 'library item is not valid JSON'],
    ['an array', '[]', 'library item payload must be a JSON object with version 1'],
    ['version 2', doc({ version: 2 }), 'library item payload must be a JSON object with version 1'],
    ['a missing edges array', JSON.stringify({ version: 1, nodes: [node0] }), 'library item must have a nodes array and an edges array'],
    ['an empty node list', doc({ nodes: [] }), 'library item has no nodes'],
    ['a fractional x', doc({ nodes: [{ ...node0, x: 1.5 }] }), 'library item nodes[0].x must be an integer'],
    ['a numeric label', doc({ nodes: [{ ...node0, label: 7 }] }), 'library item nodes[0].label must be a string'],
    [
      'a numeric edge weight',
      doc({ nodes: [node0, { ...node0, key: 1 }], edges: [{ from: 0, to: 1, label: '', color: '', strokeStyle: 'solid', weight: 3 }] }),
      'library item edges[0].weight must be a string',
    ],
    [
      'an unknown kind',
      doc({ nodes: [{ ...node0, kind: 'queue' }] }),
      "library item nodes[0].kind 'queue' is not one of service, datastore, external, boundary, note, text, chart",
    ],
    [
      'a chart without data',
      doc({ nodes: [{ ...node0, kind: 'chart' }] }),
      'library item nodes[0].chart must hold type, csv, options and source strings',
    ],
    [
      'an unknown chart type',
      doc({ nodes: [{ ...node0, kind: 'chart', chart: { type: 'heatmap', csv: 'a,b\n', options: '{}', source: 'sample' } }] }),
      `library item nodes[0].chart.type 'heatmap' is not one of ${CHART_TYPES.join(', ')}`,
    ],
    ['a repeated key', doc({ nodes: [node0, { ...node0 }] }), 'library item nodes[1].key 0 is used twice'],
    [
      'an edge to a missing node',
      doc({ edges: [{ from: 0, to: 7, label: '', color: '', strokeStyle: 'solid' }] }),
      'library item edges[0].to 7 is not a node key in this item',
    ],
    [
      'an edge with a numeric label',
      doc({ edges: [{ from: 0, to: 0, label: 3, color: '', strokeStyle: 'solid' }] }),
      'library item edges[0].label must be a string',
    ],
  ];

  it.each(CASES)('rejects %s', (_name, text, error) => {
    expect(parseLibraryPayload(text)).toEqual({ ok: false, error });
  });

  // Review Focus 5: an item saved before a stricter contract rule is refused
  // up front with the parser's sentence, so the insert writes nothing.
  it('refuses a chart whose data the current contract rejects, naming the chart', () => {
    const chart = { type: 'bars', csv: 'host,req\na,lots\n', options: '{}', source: 'human:ana' };
    expect(parseLibraryPayload(doc({ nodes: [node0, { ...node0, key: 1, label: 'req by host', kind: 'chart', chart }] }))).toEqual({
      ok: false,
      error: `library item chart "req by host": row 2, column 'req': 'lots' is not a number`,
    });
  });

  it('keeps only the known fields: focal, evidence and refs never pass through', () => {
    const result = parseLibraryPayload(
      doc({
        nodes: [{ ...node0, focal: true, evidence: 'source:x.ts:1', refs: [1] }],
        edges: [{ from: 0, to: 0, label: '', color: '', strokeStyle: 'solid', evidence: 'source:y.ts:2' }],
      })
    );
    expect(result).toEqual({
      ok: true,
      payload: { version: 1, nodes: [node0], edges: [{ from: 0, to: 0, label: '', color: '', strokeStyle: 'solid' }] },
    });
  });
});

describe('samplePlacement', () => {
  /** The examples that need more than 352 × 224; render.test.ts pins why. */
  const SIZES: Partial<Record<string, [number, number]>> = { waterfall: [352, 248], schedule: [448, 224], kanban: [448, 260] };

  it.each([...CHART_TYPES])('places the %s contract example as sample data that parses', type => {
    const p = samplePlacement(type);
    expect(p).toEqual({
      label: CHART_CONTRACTS[type].title, sublabel: '', w: SIZES[type]?.[0] ?? 352, h: SIZES[type]?.[1] ?? 224, type,
      csv: CHART_CONTRACTS[type].example, options: '{}', source: SAMPLE_SOURCE,
    });
    expect(parseChart(type, p.csv, p.options).ok).toBe(true);
  });

  it.each([...CHART_TYPES])('sizes the %s sample on the 4 px grid and at or above the chart minimum', type => {
    const { w, h } = samplePlacement(type);
    expect([w % 4, h % 4]).toEqual([0, 0]);
    expect(w >= CHART_MIN_W && h >= CHART_MIN_H).toBe(true);
  });
});

describe('saveRefusal (BUG4)', () => {
  const chartNode = mkNode(5, { kind: 'chart', w: 352, h: 224 });
  const rows = new Map([[5n, mkChart(5n)]]);

  it('refuses a selection holding a chart whose row has not arrived', () => {
    expect(saveRefusal([mkNode(7), chartNode], noCharts)).toBe(CHART_NOT_LOADED);
    // the same sentence a delete refuses with, so the two paths read alike
    expect(CHART_NOT_LOADED).toBe('chart data has not loaded yet; try again in a moment');
  });

  it('allows a selection whose charts all have their data, and one with no chart at all', () => {
    expect(saveRefusal([mkNode(7), chartNode], id => rows.get(id))).toBeNull();
    expect(saveRefusal([mkNode(7), mkNode(8)], noCharts)).toBeNull();
    expect(saveRefusal([], noCharts)).toBeNull();
  });

  it('is what keeps buildLibraryPayload from dropping the chart silently', () => {
    // Without the refusal the save would succeed with the chart missing.
    const payload = buildLibraryPayload([mkNode(7), chartNode], [mkEdge(20, 7, 5)], noCharts);
    expect(payload.nodes.map(n => n.label)).toEqual(['node-7']);
    expect(payload.edges).toEqual([]);
  });
});

describe('insertRefusal', () => {
  const plain = {
    key: 0, label: 'api', sublabel: '', x: 0, y: 0, w: 160, h: 80, token: 'ink', kind: 'service',
    doc: '', shape: 'rect', color: '', strokeStyle: 'solid', size: 'm',
  };
  const withChart: LibraryPayloadV1 = {
    version: 1,
    nodes: [
      plain,
      {
        ...plain, key: 1, label: 'p99', kind: 'chart', w: 352, h: 224,
        chart: { type: 'stat', csv: CHART_CONTRACTS.stat.example, options: '{}', source: 'sample' },
      },
    ],
    edges: [{ from: 0, to: 1, label: '', color: '', strokeStyle: 'solid' }],
  };
  const chartFree: LibraryPayloadV1 = { version: 1, nodes: [plain], edges: [] };
  // insertRefusal never reads the item; the payload argument is what it judges.
  const saved = { kind: 'saved', item: { name: 'group' } as unknown as LibraryItem } as const;

  it('refuses a chart tile on an architecture board with the module sentence', () => {
    expect(insertRefusal({ kind: 'chart', type: 'bars' }, null, true)).toBe(ARCHITECTURE_CHART_RULE);
    expect(ARCHITECTURE_CHART_RULE).toBe('charts are not supported on architecture boards yet');
  });

  it('refuses a saved item that holds a chart on an architecture board, and allows a chart-free one', () => {
    expect(insertRefusal(saved, withChart, true)).toBe(ARCHITECTURE_CHART_RULE);
    expect(insertRefusal(saved, chartFree, true)).toBeNull();
  });

  it('allows everything on a board that is not an architecture board', () => {
    expect(insertRefusal({ kind: 'chart', type: 'pie' }, null, false)).toBeNull();
    expect(insertRefusal(saved, withChart, false)).toBeNull();
    expect(insertRefusal(saved, chartFree, false)).toBeNull();
  });
});

describe('library icons (spec 2026-10-18)', () => {
  const plain = {
    key: 0, label: 'api', sublabel: '', x: 0, y: 0, w: 160, h: 80, token: 'ink', kind: 'service',
    doc: '', shape: 'rect', color: '', strokeStyle: 'solid', size: 'm',
  };
  const item = (nodes: object[]) => JSON.stringify({ version: 1, nodes, edges: [] });
  const saved = { kind: 'saved', item: { name: 'group' } as unknown as LibraryItem } as const;

  it('a saved selection keeps each node\'s icon, and nodes without one carry no icon key', () => {
    const icons = new Map([[7n, 'grok']]);
    const payload = buildLibraryPayload([mkNode(7, { kind: 'external' }), mkNode(8)], [], noCharts, () => 'regular', id => icons.get(id));
    expect(payload.nodes[0].icon).toBe('grok');
    expect('icon' in payload.nodes[1]).toBe(false);
    const parsed = parseLibraryPayload(JSON.stringify(payload));
    expect(parsed.ok && parsed.payload.nodes[0].icon).toBe('grok');
    // a note never carries one, even if a row says so: the parser would refuse the item
    const notes = buildLibraryPayload([mkNode(9, { kind: 'note' })], [], noCharts, () => 'regular', () => 'agent');
    expect('icon' in notes.nodes[0]).toBe(false);
    // the default iconOf keeps old callers unchanged
    expect('icon' in buildLibraryPayload([mkNode(7)], [], noCharts).nodes[0]).toBe(false);
  });

  it('refuses an item whose icon is not a library icon, or sits on a note, naming the field', () => {
    expect(parseLibraryPayload(item([{ ...plain, icon: 'clippy' }]))).toEqual({ ok: false, error: "library item nodes[0].icon 'clippy' is not a library icon" });
    expect(parseLibraryPayload(item([{ ...plain, icon: 7 }]))).toEqual({ ok: false, error: "library item nodes[0].icon '7' is not a library icon" });
    expect(parseLibraryPayload(item([{ ...plain, kind: 'note', icon: 'agent' }]))).toEqual({ ok: false, error: 'library item nodes[0].icon is set on a note node' });
    expect(parseLibraryPayload(item([{ ...plain, kind: 'boundary', icon: 'aws' }])).ok).toBe(true);
  });

  it('an icon tile places a 160 x 96 node of the icon\'s kind, named after it, with the icon', () => {
    expect(iconNodePlacement('model')).toEqual({ label: 'Model', sublabel: '', w: ICON_NODE_W, h: ICON_NODE_H, token: 'ink', focal: false, kind: 'external', icon: 'model' });
    expect([ICON_NODE_W % 4, ICON_NODE_H % 4]).toEqual([0, 0]);
    for (const i of ICONS) expect(iconNodePlacement(i.id).kind).toBe(i.kind);
    expect(() => iconNodePlacement('clippy')).toThrow("icon 'clippy' is not a library icon");
  });

  it('refuses icons on architecture boards: a tile, or a saved item that holds one', () => {
    expect(insertRefusal({ kind: 'icon', icon: 'agent' }, null, true)).toBe(ARCHITECTURE_ICON_RULE);
    expect(ARCHITECTURE_ICON_RULE).toBe('icons are not supported on architecture boards yet');
    const withIcon = parseLibraryPayload(item([plain, { ...plain, key: 1, icon: 'queue' }]));
    const iconFree = parseLibraryPayload(item([plain]));
    expect(withIcon.ok && iconFree.ok).toBe(true);
    if (!withIcon.ok || !iconFree.ok) return;
    expect(insertRefusal(saved, withIcon.payload, true)).toBe(ARCHITECTURE_ICON_RULE);
    expect(insertRefusal(saved, iconFree.payload, true)).toBeNull();
    expect(insertRefusal({ kind: 'icon', icon: 'agent' }, null, false)).toBeNull();
  });
});
