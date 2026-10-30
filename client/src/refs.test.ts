import { describe, it, expect } from 'vitest';
import type { CodeRef } from './module_bindings/types';
import { buildRefsIndex, pruneOrphanRefs, refsKeyFor, parseCoverage, symbolNeedle, buildBadgeTitles, badgeFor, badgeTitle, edgeBadgeFor, visibleStale, buildNodeBadges, sizedBadge } from './refs';

function mkRef(id: number, over: Partial<CodeRef> = {}): CodeRef {
  return {
    id: BigInt(id),
    boardId: 1n,
    targetKind: 'node',
    targetId: 10n,
    path: 'client/src/render.ts',
    symbol: 'renderBoard',
    startLine: 448,
    endLine: 460,
    blobSha: 'a'.repeat(40),
    snippet: 'export function renderBoard(',
    author: '',
    checkpoint: 1,
    status: 'ok',
    ...over,
  };
}

describe('buildRefsIndex', () => {
  it('groups refs by target key, filters by board, sorts by id', () => {
    const idx = buildRefsIndex(
      [mkRef(3), mkRef(1), mkRef(2, { targetKind: 'edge', targetId: 5n }), mkRef(4, { boardId: 2n })],
      1n
    );
    expect([...idx.keys()].sort()).toEqual(['edge:5', 'node:10']);
    expect(idx.get('node:10')!.map(r => r.id)).toEqual([1n, 3n]);
    expect(idx.get('edge:5')).toHaveLength(1);
  });

  it('carries only the summary fields (no snippet, no sha)', () => {
    const [r] = buildRefsIndex([mkRef(1)], 1n).get('node:10')!;
    expect(r).toEqual({
      id: 1n,
      symbol: 'renderBoard',
      path: 'client/src/render.ts',
      startLine: 448,
      endLine: 460,
      checkpoint: 1,
      status: 'ok',
    });
  });

  it('is empty for an empty iterable', () => {
    expect(buildRefsIndex([], 1n).size).toBe(0);
  });
});

describe('pruneOrphanRefs', () => {
  it('drops refs whose node or edge target is gone and returns the live count', () => {
    const idx = buildRefsIndex(
      [
        mkRef(1), // node 10 — alive
        mkRef(2), // node 10 — alive
        mkRef(3, { targetId: 11n }), // node 11 — deleted
        mkRef(4, { targetKind: 'edge', targetId: 5n }), // edge 5 — alive
        mkRef(5, { targetKind: 'edge', targetId: 6n }), // edge 6 — deleted
      ],
      1n
    );
    const live = pruneOrphanRefs(idx, new Set([10n]), new Set([5n]));
    expect(live).toBe(3);
    expect([...idx.keys()].sort()).toEqual(['edge:5', 'node:10']);
    expect(idx.get('node:10')!.map(r => r.id)).toEqual([1n, 2n]);
  });

  it('keeps everything when every target exists, and empties when none do', () => {
    const full = buildRefsIndex([mkRef(1), mkRef(2, { targetKind: 'edge', targetId: 5n })], 1n);
    expect(pruneOrphanRefs(full, new Set([10n]), new Set([5n]))).toBe(2);
    expect(full.size).toBe(2);
    const none = buildRefsIndex([mkRef(1), mkRef(2, { targetKind: 'edge', targetId: 5n })], 1n);
    expect(pruneOrphanRefs(none, new Set(), new Set())).toBe(0);
    expect(none.size).toBe(0);
  });
});

describe('refsKeyFor', () => {
  it('encodes count, size, the first symbol and the title revision', () => {
    const refs = buildRefsIndex([mkRef(1), mkRef(2, { symbol: 'other' })], 1n).get('node:10')!;
    expect(refsKeyFor(refs, 160, 80)).toBe('2|160|80|renderBoard|0');
    expect(refsKeyFor(refs, 160, 80, 3)).toBe('2|160|80|renderBoard|3');
    expect(refsKeyFor([], 160, 80)).toBe('0|160|80||0');
  });
});

describe('stale and ambiguous refs at board level (G12)', () => {
  const refs = () =>
    buildRefsIndex(
      [
        mkRef(1, { symbol: 'boardLink', status: 'stale' }),
        mkRef(2, { symbol: 'formatSummary' }),
        mkRef(3, { symbol: 'ResultOptions', status: 'ambiguous' }),
      ],
      1n
    ).get('node:10')!;

  it('the badge symbol slot takes the first ok ref and counts the rest by status', () => {
    const b = badgeFor(refs(), 240, 80, { title: '', rev: 0 });
    expect(b.first).toBe('formatSummary');
    expect(b.count).toBe(3);
    expect(b.stale).toBe(1);
    expect(b.ambiguous).toBe(1);
  });

  it('node badges are built once per table change; a frame only sizes them and reads no ref', () => {
    const index = buildRefsIndex([mkRef(1, { status: 'stale' }), mkRef(2, { symbol: 'formatSummary' })], 1n);
    const titles = buildBadgeTitles(index, new Map());
    const bases = buildNodeBadges(index, titles);
    const refs = index.get('node:10')!;
    for (const [w, h] of [[160, 80], [240, 96]]) {
      expect(sizedBadge(bases.get(10n)!, w, h)).toEqual(badgeFor(refs, w, h, titles.get(10n)!));
    }
    // the frame path takes no ref list at all
    expect(sizedBadge.length).toBe(3);
    expect(bases.size).toBe(1);
  });

  it('no ok ref leaves the symbol slot empty', () => {
    const only = buildRefsIndex([mkRef(1, { status: 'stale' })], 1n).get('node:10')!;
    expect(badgeFor(only, 240, 80, { title: '', rev: 0 }).first).toBe('');
  });

  it('a status-only change changes the key; all-ok keys are unchanged', () => {
    const ok = buildRefsIndex([mkRef(1), mkRef(2, { symbol: 'other' })], 1n).get('node:10')!;
    const stale = buildRefsIndex([mkRef(1), mkRef(2, { symbol: 'other', status: 'stale' })], 1n).get('node:10')!;
    expect(refsKeyFor(ok, 160, 80)).toBe('2|160|80|renderBoard|0');
    expect(refsKeyFor(stale, 160, 80)).not.toBe(refsKeyFor(ok, 160, 80));
    const amb = buildRefsIndex([mkRef(1), mkRef(2, { symbol: 'other', status: 'ambiguous' })], 1n).get('node:10')!;
    expect(refsKeyFor(amb, 160, 80)).not.toBe(refsKeyFor(stale, 160, 80));
  });

  it('the rail counts only refs whose owner is on the canvas, the set its click walks', () => {
    const index = buildRefsIndex(
      [
        mkRef(1, { status: 'stale' }), // node 10
        mkRef(2, { targetKind: 'edge', targetId: 5n, status: 'ambiguous' }),
        mkRef(3, { targetId: 11n }), // node 11, all ok
      ],
      1n
    );
    expect(visibleStale(index, new Set([10n, 11n]), new Set([5n]))).toEqual({
      owners: [
        { kind: 'node', id: 10n, refId: 1n },
        { kind: 'edge', id: 5n, refId: 2n },
      ],
      stale: 1,
      ambiguous: 1,
    });
    expect(visibleStale(index, new Set([11n]), new Set([5n]))).toEqual({
      owners: [{ kind: 'edge', id: 5n, refId: 2n }],
      stale: 0,
      ambiguous: 1,
    });
  });

  it('a board whose only stale ref sits on a hidden node shows no stale line', () => {
    const index = buildRefsIndex([mkRef(1, { status: 'stale' }), mkRef(2, { targetId: 11n })], 1n);
    // node 10 holds the stale ref and is hidden: only node 11 is on the canvas
    expect(visibleStale(index, new Set([11n]), new Set())).toEqual({ owners: [], stale: 0, ambiguous: 0 });
  });

  it('the badge title marks stale and ambiguous lines', () => {
    expect(badgeTitle(refs()).split('\n')).toEqual([
      'boardLink · client/src/render.ts:448–460 (stale)',
      'formatSummary · client/src/render.ts:448–460',
      'ResultOptions · client/src/render.ts:448–460 (ambiguous)',
    ]);
  });
});

describe('buildBadgeTitles', () => {
  it('lists symbol · path:start–end per ref and bumps rev only when the text changes', () => {
    const a = buildBadgeTitles(buildRefsIndex([mkRef(1), mkRef(2, { targetKind: 'edge', targetId: 5n })], 1n), new Map());
    expect([...a.keys()]).toEqual([10n]); // node titles; edge titles are built apart (G51)
    expect(a.get(10n)).toEqual({ title: 'renderBoard · client/src/render.ts:448–460', rev: 0 });
    const same = buildBadgeTitles(buildRefsIndex([mkRef(1)], 1n), a);
    expect(same.get(10n)!.rev).toBe(0);
    const moved = buildBadgeTitles(buildRefsIndex([mkRef(1, { startLine: 450, endLine: 462 })], 1n), same);
    expect(moved.get(10n)).toEqual({ title: 'renderBoard · client/src/render.ts:450–462', rev: 1 });
  });
});

describe('parseCoverage', () => {
  const EMPTY = { changed: 0, uncovered: [], excluded: [], deleted: [] };

  it('parses the documented shape', () => {
    const json =
      '{"changed":31,"uncovered":["client/src/palette.ts"],' +
      '"excluded":[{"reason":"generated bindings","paths":["client/src/module_bindings/code_ref_table.ts"]}],' +
      '"deleted":["docs/old.md"]}';
    expect(parseCoverage(json)).toEqual({
      changed: 31,
      uncovered: ['client/src/palette.ts'],
      excluded: [{ reason: 'generated bindings', paths: ['client/src/module_bindings/code_ref_table.ts'] }],
      deleted: ['docs/old.md'],
    });
  });

  it('returns the empty coverage on malformed input', () => {
    for (const bad of ['', '{}', 'null', '[]', '{"changed":"x","uncovered":"no"}', '{not json', '42']) {
      expect(parseCoverage(bad), bad).toEqual(EMPTY);
    }
  });

  it('drops non-string entries and groups without a reason', () => {
    const json =
      '{"changed":2,"uncovered":["a",1],"excluded":[{"reason":"gen","paths":["b",null]},{"paths":["c"]}],"deleted":[2]}';
    expect(parseCoverage(json)).toEqual({
      changed: 2,
      uncovered: ['a'],
      excluded: [{ reason: 'gen', paths: ['b'] }],
      deleted: [],
    });
  });
});

describe('symbolNeedle (same rule as module, agent and eval)', () => {
  it('is the last dotted segment, or the whole symbol when undotted', () => {
    expect(symbolNeedle('Limiter.allow')).toBe('allow');
    expect(symbolNeedle('Editor.toggleCodeOverlay')).toBe('toggleCodeOverlay');
    expect(symbolNeedle('a.b.c')).toBe('c');
    expect(symbolNeedle('renderBoard')).toBe('renderBoard');
    expect(symbolNeedle('trailing.')).toBe('trailing.');
    expect(symbolNeedle('')).toBe('');
  });
});

describe('edge suffix inputs (G51)', () => {
  it('builds edge titles apart from node titles and keys the suffix on count and revision', () => {
    const index = buildRefsIndex([mkRef(1), mkRef(2, { targetKind: 'edge', targetId: 10n, symbol: 'buildEditorHref' })], 1n);
    const edges = buildBadgeTitles(index, new Map(), 'edge');
    expect([...edges.keys()]).toEqual([10n]);
    expect(edges.get(10n)!.title).toBe('buildEditorHref · client/src/render.ts:448–460');
    const b = edgeBadgeFor(index.get('edge:10')!, edges.get(10n)!);
    expect(b).toEqual({ key: refsKeyFor(index.get('edge:10')!, 0, 0, 0), count: 1, title: 'buildEditorHref · client/src/render.ts:448–460' });
  });
});

describe('parseCoverage keeps unconfirmed migrations (spec 2026-10-16 D2)', () => {
  it('reads the list when present and leaves it out otherwise', () => {
    expect(parseCoverage('{"changed":2,"uncovered":[],"excluded":[],"deleted":[],"unconfirmed":["migrations/0043.sql",7]}').unconfirmed).toEqual(['migrations/0043.sql']);
    expect('unconfirmed' in parseCoverage('{"changed":2}')).toBe(false);
  });
});
