import { describe, expect, it } from 'vitest';
import { buildThreatIndex, looksPii, threatRailText } from './threats-view';
import type { Threat } from './module_bindings/types';

const ts = (ms: number) => ({ microsSinceUnixEpoch: BigInt(ms) * 1000n }) as unknown as Threat['createdAt'];
const row = (o: Partial<Threat>): Threat => ({
  id: 1n, boardId: 1n, anchorId: 10n, stage: 'vulnerable', severity: 'low', title: 't', summary: 's', cvss: '', package: '', fixedIn: '',
  flags: '', source: '', author: 'a', createdAt: ts(1000), containedBy: '', containedAt: ts(0), ...o,
}) as Threat;
const labelOf = (id: bigint) => (id === 10n ? 'auth' : 'x');

describe('buildThreatIndex', () => {
  it('orders open compromised critical first, contained last', () => {
    const idx = buildThreatIndex([
      row({ id: 1n, containedBy: 'bob', containedAt: ts(5000), stage: 'compromised', severity: 'critical' }),
      row({ id: 2n, stage: 'vulnerable', severity: 'low' }),
      row({ id: 3n, stage: 'compromised', severity: 'critical' }),
    ]);
    expect(idx.byAnchor.get(10n)!.map(t => t.id)).toEqual([3n, 2n, 1n]);
    expect(idx.open).toBe(2);
    expect(idx.contained).toBe(1);
    const c = idx.byAnchor.get(10n)![2];
    expect(c.contained).toBe(true);
    expect(c.containedAt).toEqual(new Date(5000));
    expect(idx.byAnchor.get(10n)![0].containedAt).toBeNull();
  });
  it('survives bad flags and source', () => {
    const t = buildThreatIndex([row({ flags: 'nope', source: '{' })]).byAnchor.get(10n)![0];
    expect(t.flags).toEqual([]);
    expect(t.source).toBeNull();
    const ok = buildThreatIndex([row({ flags: '["a"]', source: '{"system":"Trivy","ref":"1"}' })]).byAnchor.get(10n)![0];
    expect(ok.flags).toEqual(['a']);
    expect(ok.source).toEqual({ system: 'Trivy', ref: '1' });
  });
});

describe('threatRailText', () => {
  it('matches each case', () => {
    expect(threatRailText(buildThreatIndex([]), labelOf)).toBe('');
    expect(threatRailText(buildThreatIndex([row({ stage: 'compromised' })]), labelOf)).toBe('1 threat · auth compromised');
    expect(threatRailText(buildThreatIndex([row({ id: 1n }), row({ id: 2n })]), labelOf)).toBe('2 threats');
    expect(threatRailText(buildThreatIndex([row({ id: 1n }), row({ id: 2n, containedBy: 'b' })]), labelOf)).toBe('2 threats · 1 contained');
  });
});

describe('looksPii', () => {
  it('matches the PII word', () => {
    expect(looksPii({ sublabel: 'postgres · PII', doc: '' })).toBe(true);
    expect(looksPii({ sublabel: 'pipeline', doc: '' })).toBe(false);
  });
});

describe('threatRailText plural and visibility', () => {
  it('one contained and none open reads 1 threat, never 1 threats', () => {
    expect(threatRailText(buildThreatIndex([row({ containedBy: 'b' })]), labelOf)).toBe('1 threat · 1 contained');
  });
  it('counts every threat and names how many sit on hidden nodes', () => {
    const idx = buildThreatIndex([row({ id: 1n }), row({ id: 2n, anchorId: 11n }), row({ id: 3n, anchorId: 11n, containedBy: 'b' })]);
    expect(threatRailText(idx, labelOf, new Set([10n, 11n]))).toBe('3 threats · 1 contained');
    expect(threatRailText(idx, labelOf, new Set([11n]))).toBe('3 threats · 1 contained · 1 on a hidden node');
    expect(threatRailText(idx, labelOf, new Set([10n]))).toBe('3 threats · 1 contained · 2 on hidden nodes');
    expect(threatRailText(buildThreatIndex([row({ stage: 'compromised' })]), labelOf, new Set())).toBe('1 threat · auth compromised · 1 on a hidden node');
  });
});
