import { describe, expect, it } from 'vitest';
import { DbError } from '../../shared/db-http';
import { boardText, readBoard, type BoardRows } from './board';
import type { Database, SafeU64 } from './db';

const many = <X>(n: number, f: (i: number) => X): X[] => Array.from({ length: n }, (_, i) => f(i));
const board = (count = 20): BoardRows => ({
  board: { id: 1n, name: 'main' },
  nodes: many(count, i => ({ id: BigInt(i + 1), boardId: 1n, label: `n${i}`, sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false, kind: 'service', sourceKey: '', hidden: false, doc: '' })),
  edges: [], hideSets: [], members: [], refs: [], charts: [], version: undefined, notes: [], threats: [], icons: [],
  session: { checkpoint: 1, headSha: 'h', coverage: '{}' }, routes: [], events: [],
});

function plan(rows: BoardRows, eventCount = 1) {
  const nodeIds = rows.nodes.map(n => n.id);
  rows.routes = [{ boardId: 1n, nodeIds, currentIndex: -1, currentCheckpoint: 0, revision: 1 }];
  rows.events = many(eventCount, i => ({ id: BigInt(i + 1), boardId: 1n, nodeIds, kind: 'plan', revision: i + 1, reason: '', checkpoint: 0 }));
}

describe('readBoard', () => {
  // An empty list would read as "no notes": the agent would then drop a column a migration note flagged.
  it.each(['visible_change_note', 'visible_threat', 'visible_node_icon'])('fails when %s cannot be read', async view => {
    const db = { read: async (q: { text: string }) => { if (q.text.includes(view)) throw new DbError(503, 'the database answered 503'); return []; } } as unknown as Database;
    await expect(readBoard(db, 1n as SafeU64)).rejects.toThrow(/503/);
  });
});

describe('get_board icons', () => {
  it('gives a node with a library icon its id, and no icon key to the rest', () => {
    const rows = board(2);
    rows.icons = [{ nodeId: 2n, boardId: 1n, icon: 'claude' }];
    const nodes = JSON.parse(boardText(rows, 1n)).nodes as Array<{ id: string; icon?: string }>;
    expect(nodes.find(n => n.id === '2')?.icon).toBe('claude');
    expect('icon' in nodes.find(n => n.id === '1')!).toBe(false);
  });
});

describe('get_board threats', () => {
  it('lists threats, and leaves the key out when there are none', () => {
    const rows = board(2);
    expect(JSON.parse(boardText(rows, 1n)).threats).toBeUndefined();
    rows.threats = [{ id: 5n, boardId: 1n, anchorId: 2n, stage: 'compromised', severity: 'critical', title: 'CVE-2026-31337', containedBy: '' }];
    expect(JSON.parse(boardText(rows, 1n)).threats).toEqual([
      { id: '5', anchorId: '2', stage: 'compromised', severity: 'critical', title: 'CVE-2026-31337', contained: false },
    ]);
  });
});

describe('get_board change notes', () => {
  it('lists notes with reader subjects and status, and leaves the key out when there are none', () => {
    const rows = board(2);
    expect(JSON.parse(boardText(rows, 1n)).changeNotes).toBeUndefined();
    rows.notes = [{
      id: 3n, boardId: 1n, anchorId: 1n, refId: 9n, kind: 'migration', severity: 'destructive', title: 'Migration 0042',
      subjects: '[{"table":"customers","column":"name"}]', readers: '[{"refId":"11","subject":0,"status":"stale","checkpoint":1}]', reviewedBy: '',
    }];
    expect(JSON.parse(boardText(rows, 1n)).changeNotes).toEqual([{
      id: '3', anchorId: '1', kind: 'migration', severity: 'destructive', title: 'Migration 0042', refId: '9',
      readers: [{ refId: '11', subject: 'customers.name', status: 'stale' }], reviewed: false,
    }]);
  });
});

describe('get_board within its cap', () => {
  it('caps the coverage lists when they alone exceed it, and says how many were left out', () => {
    const coverage = { changed: 3000, uncovered: many(3000, i => `src/generated/file-${i}.ts`), excluded: [], deleted: [] };
    const rows = board();
    rows.session!.coverage = JSON.stringify(coverage);
    const text = boardText(rows, 1n, 45_000);
    expect(text.length).toBeLessThanOrEqual(45_000);
    const out = JSON.parse(text);
    expect(out.session.coverage.uncovered).toHaveLength(100);
    expect(out.omitted.uncovered).toBe(2900);
    expect(out.nodes).toHaveLength(20);
  });

  it('bounds waypoints and nested history node IDs while retaining board nodes and route progress', () => {
    const rows = board(600);
    plan(rows);
    const text = boardText(rows, 1n);
    const out = JSON.parse(text);
    expect(text.length).toBeLessThanOrEqual(45_000);
    expect(out.nodes.length).toBeGreaterThan(0);
    expect(out.route.destinationId).toBe('600');
    expect(out.route.currentIndex).toBe(-1);
    expect(out.route.waypoints).toHaveLength(100);
    expect(out.route.history[0].nodeIds).toHaveLength(100);
    expect(out.omitted.routeWaypoints).toBe(500);
    expect(out.omitted.routeNodeIds).toBe(500);
  });

  it('fits many excluded groups, hide sets and nested route histories, disclosing omitted counts', () => {
    const rows = board(600);
    plan(rows, 150);
    rows.hideSets = many(2000, i => ({ name: `hide-${i}-${'x'.repeat(80)}` }));
    const coverage = { changed: 60_000, uncovered: [], deleted: [], excluded: many(300, i => ({ reason: `group-${i}`, paths: many(200, j => `src/group-${i}/file-${j}.ts`) })) };
    rows.session!.coverage = JSON.stringify(coverage);
    const text = boardText(rows, 1n);
    const out = JSON.parse(text);
    expect(text.length).toBeLessThanOrEqual(45_000);
    expect(out.nodes.length).toBeGreaterThan(0);
    expect(out.route.history.at(-1).id).toBe('150');
    expect(out.omitted.hideSets).toBe(2000 - out.hideSets.length);
    expect(out.omitted.excludedGroups).toBe(300 - out.session.coverage.excluded.length);
    expect(out.omitted.excludedPaths).toBe(60_000 - out.session.coverage.excluded.reduce((n: number, g: { paths: string[] }) => n + g.paths.length, 0));
    expect(out.omitted.routeHistory).toBe(150 - out.route.history.length);
    expect(out.omitted.routeNodeIds).toBe(90_000 - out.route.history.reduce((n: number, e: { nodeIds: string[] }) => n + e.nodeIds.length, 0));
  });

  it('fits a header even when a single list entry or opaque coverage exceeds the character budget', () => {
    const rows = board();
    const long = 'x'.repeat(100_000);
    rows.hideSets = [{ name: long }];
    rows.session!.coverage = JSON.stringify({ changed: 1, uncovered: [long], excluded: [], deleted: [], extra: long });
    const text = boardText(rows, 1n);
    const out = JSON.parse(text);
    expect(text.length).toBeLessThanOrEqual(45_000);
    expect(out.nodes).toHaveLength(20);
    expect(out.omitted.hideSets).toBe(1);
    expect(out.omitted.uncovered).toBe(1);
    expect(out.omitted.sessionHeader).toBe(1);
  });
});
