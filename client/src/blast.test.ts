import { describe, expect, it } from 'vitest';
import { blastRadius } from './blast';

const N = { gateway: 1n, auth: 2n, users: 3n, sess: 4n, pay: 5n, orders: 6n, stripe: 7n, odb: 8n, search: 9n };
const names: Record<string, string> = { 1: 'gateway', 2: 'auth', 3: 'users', 4: 'sess', 5: 'payments', 6: 'orders', 7: 'stripe', 8: 'odb', 9: 'search' };
const labelOf = (id: bigint) => names[String(id)];
const ids = Object.values(N);
const e = (id: number, fromNode: bigint, toNode: bigint, label = '') => ({ id: BigInt(id), fromNode, toNode, label });
const mock = [
  e(1, N.gateway, N.auth, 'verify'), e(2, N.auth, N.users, 'reads'), e(3, N.auth, N.sess, 'writes'),
  e(4, N.pay, N.auth, 'verify'), e(5, N.orders, N.auth, 'verify'), e(6, N.pay, N.stripe),
  e(7, N.orders, N.odb), e(8, N.gateway, N.search),
];
const set = (b: ReturnType<typeof blastRadius>, hop: number) => [...b.nodes].filter(([, n]) => n.hop === hop).map(([id]) => id).sort();

describe('blastRadius', () => {
  it('walks only edges whose ends are both in nodeIds (a note or boundary never joins the blast)', () => {
    const note = 50n;
    const b = blastRadius(1n, [1n, 2n, 3n], [e(1, 1n, note), e(2, note, 3n), e(3, 1n, 2n)], labelOf, { direction: 'both', depth: 'all' });
    expect([...b.nodes.keys()]).toEqual([2n]);
    expect([...b.edges.keys()]).toEqual([3n]);
    expect(b.clear).toEqual([3n]);
  });
  it('both, depth 2', () => {
    const b = blastRadius(N.auth, ids, mock, labelOf, { direction: 'both', depth: 2 });
    expect(set(b, 1)).toEqual([N.gateway, N.users, N.sess, N.pay, N.orders].sort());
    expect(set(b, 2)).toEqual([N.stripe, N.odb, N.search].sort());
    expect(b.nodes.get(N.users)!.why).toBe('reads');
    expect(b.nodes.get(N.stripe)!.why).toBe('via payments');
    expect(b.nodes.has(N.auth)).toBe(false);
    expect(b.edges.get(6n)).toBe(2);
    expect(b.edges.get(2n)).toBe(1);
    expect(b.clear).toEqual([]);
  });
  it('reaches / trusts depth 1', () => {
    expect(set(blastRadius(N.auth, ids, mock, labelOf, { direction: 'reaches', depth: 1 }), 1)).toEqual([N.users, N.sess].sort());
    const t = blastRadius(N.auth, ids, mock, labelOf, { direction: 'trusts', depth: 1 });
    expect([...t.nodes.keys()].sort()).toEqual([N.gateway, N.pay, N.orders].sort());
    expect(t.clear).toEqual([N.users, N.sess, N.stripe, N.odb, N.search]);
  });
  it('depth all matches depth 2 here', () => {
    const a = blastRadius(N.auth, ids, mock, labelOf, { direction: 'both', depth: 'all' });
    const b = blastRadius(N.auth, ids, mock, labelOf, { direction: 'both', depth: 2 });
    expect([...a.nodes.keys()].sort()).toEqual([...b.nodes.keys()].sort());
  });
  it('unlabelled edges', () => {
    const b = blastRadius(1n, [1n, 2n, 3n], [e(1, 1n, 2n), e(2, 3n, 1n)], labelOf, { direction: 'both', depth: 1 });
    expect(b.nodes.get(2n)!.why).toBe('calls');
    expect(b.nodes.get(3n)!.why).toBe('trusts it');
  });
  it('cycles, self-loops and parallel edges terminate', () => {
    const b = blastRadius(1n, [1n, 2n], [e(1, 1n, 2n), e(2, 2n, 1n), e(3, 1n, 1n), e(4, 1n, 2n)], labelOf, { direction: 'both', depth: 'all' });
    expect([...b.nodes.keys()]).toEqual([2n]);
    expect(b.nodes.get(2n)!.hop).toBe(1);
    expect([...b.edges.keys()].sort()).toEqual([1n, 2n, 4n]);
  });
  it('a long chain stays fast', () => {
    const n = 2000;
    const nodeIds = Array.from({ length: n }, (_, i) => BigInt(i));
    const chain = Array.from({ length: n - 1 }, (_, i) => e(i, BigInt(i), BigInt(i + 1)));
    const t0 = performance.now();
    const b = blastRadius(0n, nodeIds, chain, () => 'x', { direction: 'reaches', depth: 'all' });
    expect(performance.now() - t0).toBeLessThan(50);
    expect(b.nodes.size).toBe(n - 1);
    for (let i = 1; i < n; i++) expect(b.nodes.get(BigInt(i))!.hop).toBe(i);
  });
  it('an unconnected node is clear', () => {
    expect(blastRadius(N.auth, [...ids, 99n], mock, labelOf, { direction: 'both', depth: 'all' }).clear).toEqual([99n]);
  });
});
