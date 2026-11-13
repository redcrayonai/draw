import { expect, it } from 'vitest';
import { LocalActivity } from './local-activity';
import { localInteraction, type LocalTrafficWindow } from '../../shared/local-activity';
import type { LocalBoard } from '../../shared/local';

const board = { nodes: [{ id: '1' }, { id: '2' }], edges: [{ id: '3', from: '1', to: '2' }] } as LocalBoard;
const mapping = { api: '1', db: '2' };
it('counts directions, errors and measured latencies, flushes a partial window and expires it', () => {
  const frames: LocalTrafficWindow[] = []; const activity = new LocalActivity(w => frames.push(w), 1000);
  expect(activity.accept(board, mapping, [
    { from: 'api', to: 'db', duration_ms: 12 }, { from: 'api', to: 'db', error: true },
    { from: 'db', to: 'api' }, { from: 'api', to: 'db', duration_ms: 24 },
  ], 1100)).toEqual({ accepted: 4, rejected: {} });
  activity.flush(1500);
  expect(frames[0]).toMatchObject({ duration: 500, stale: false, traffic: [
    { edge: '3', reverse: false, count: 3, errors: 1, samples: 2, p50: 12, p95: 24 },
    { edge: '3', reverse: true, count: 1, samples: 0, p50: null, p95: null },
  ] });
  activity.flush(4100); expect(frames[1].stale).toBe(true);
});
it.each([null, [], {}, { from: '', to: 'db' }, { from: 'api', to: 'db', duration_ms: -1 }, { from: 'api', to: 'db', duration_ms: Infinity }, { from: 'api', to: 'db', duration_ms: null }, { from: 'api', to: 'db', error: 1 }])('rejects invalid events %j', value => {
  expect(() => localInteraction(value)).toThrow('REJECTED');
});
it('drops unknown mappings, missing and ambiguous connections without inventing edges', () => {
  const activity = new LocalActivity(() => {});
  expect(activity.accept(board, {}, [{ from: 'api', to: 'db' }]).accepted).toBe(0);
  expect(activity.accept({ ...board, edges: [] }, mapping, [{ from: 'api', to: 'db' }]).rejected).toEqual({ 'missing connection': 1 });
  expect(activity.accept({ ...board, edges: [...board.edges, { ...board.edges[0], id: '4' }] }, mapping, [{ from: 'api', to: 'db' }]).rejected).toEqual({ 'ambiguous connection': 1 });
});
it('reports sample and event-rate limits without silently sampling totals', () => {
  const activity = new LocalActivity(() => {}, 0);
  const measured = Array.from({ length: 250 }, () => ({ from: 'api', to: 'db', duration_ms: 1 }));
  for (let i = 0; i < 4; i++) expect(activity.accept(board, mapping, measured, 100).accepted).toBe(250);
  expect(activity.accept(board, mapping, measured, 100)).toEqual({ accepted: 24, rejected: { 'latency sample limit': 226 } });
  const unmeasured = measured.map(({ from, to }) => ({ from, to }));
  for (let i = 0; i < 35; i++) activity.accept(board, mapping, unmeasured, 100);
  expect(activity.accept(board, mapping, unmeasured, 100)).toEqual({ accepted: 226, rejected: { 'event rate limit': 24 } });
  expect(activity.accept(board, mapping, unmeasured, 100).accepted).toBe(0);
  activity.flush(1000);
  expect(activity.accept(board, mapping, unmeasured, 1100).accepted).toBe(250);
});
it('caps distinct directional edge buckets', () => {
  const activity = new LocalActivity(() => {});
  const large = { nodes: [{ id: 'root' }, ...Array.from({ length: 1001 }, (_, i) => ({ id: String(i) }))], edges: Array.from({ length: 1001 }, (_, i) => ({ id: `e${i}`, from: 'root', to: String(i) })) } as LocalBoard;
  const services = Object.fromEntries(large.nodes.map(n => [n.id, n.id]));
  for (let i = 0; i < 1000; i++) expect(activity.accept(large, services, [{ from: 'root', to: String(i) }]).accepted).toBe(1);
  expect(activity.accept(large, services, [{ from: 'root', to: '1000' }]).rejected).toEqual({ 'edge window limit': 1 });
});

it('drops pending and published traffic when an edge is repointed or removed', () => {
  const frames: LocalTrafficWindow[] = [], activity = new LocalActivity(w => frames.push(w), 0);
  activity.accept(board, mapping, [{ from: 'api', to: 'db' }], 10);
  activity.flush(20);
  activity.accept(board, mapping, [{ from: 'api', to: 'db' }], 30);
  const changed = { ...board, nodes: [...board.nodes, { id: '4' }], edges: [{ id: '3', from: '1', to: '4' }] } as LocalBoard;
  activity.reconcile(changed);
  expect(activity.snapshot().traffic).toEqual([]);
  activity.accept(changed, { api: '1', db: '4' }, [{ from: 'api', to: 'db' }], 40);
  activity.flush(50);
  expect(activity.snapshot().traffic).toEqual([expect.objectContaining({ edge: '3', count: 1 })]);
  activity.reconcile({ ...changed, edges: [] });
  expect(frames.at(-1)?.traffic).toEqual([]);
});
