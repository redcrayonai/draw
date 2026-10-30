import { describe, expect, it } from 'vitest';
import { peekPosition, renderThreatPeek } from './threat-peek';
import type { ThreatView } from './threats-view';

const threat = (o: Partial<ThreatView> = {}): ThreatView => ({
  id: 1n, anchorId: 2n, stage: 'compromised', severity: 'critical', title: 'Bulk read of customers-db', summary: 'SELECT * then outbound 443.',
  cvss: '', package: '', fixedIn: '', flags: [], source: null, author: '', createdAt: new Date(0), containedBy: '', containedAt: null, contained: false, ...o,
});

describe('renderThreatPeek', () => {
  it('severity and stage, title, summary, reach with PII', () => {
    const el = renderThreatPeek({ threat: threat(), total: 2, reach: { nodes: 4, hops: 1, pii: 1 } });
    expect(el.querySelector('.tp-sev')!.textContent).toBe('critical · compromised');
    expect(el.querySelector('.tp-more')!.textContent).toBe('1 of 2');
    expect(el.querySelector('.tp-title')!.textContent).toBe('Bulk read of customers-db');
    expect(el.querySelector('.tp-reach')!.textContent).toBe('Reaches 4 nodes in 1 hop1 PII');
  });

  it('words a lone node, several hops, nothing reached and a contained threat', () => {
    const one = renderThreatPeek({ threat: threat({ contained: true }), total: 1, reach: { nodes: 1, hops: 3, pii: 0 } });
    expect(one.querySelector('.tp-reach')!.textContent).toBe('Reaches 1 node in 3 hops');
    expect(one.querySelector('.tp-sev')!.textContent).toBe('critical · contained');
    expect(one.querySelector('.tp-more')).toBeNull();
    const none = renderThreatPeek({ threat: threat(), total: 1, reach: { nodes: 0, hops: 0, pii: 0 } });
    expect(none.querySelector('.tp-reach')!.textContent).toBe('Reaches nothing on the drawn edges');
  });
});

describe('peekPosition', () => {
  const anchor = { x: 400, y: 300, w: 200, h: 60 };
  const size = { w: 300, h: 150 };
  const bounds = { left: 0, top: 0, right: 1400, bottom: 900 };
  const node = (x: number, y: number) => ({ x, y, w: 160, h: 60 });

  it('goes below when the blast travels right (the SIEM board)', () => {
    const right = [node(900, 120), node(900, 270), node(900, 420), node(900, 570)];
    expect(peekPosition(anchor, [...right, node(40, 300)], size, bounds)).toEqual({ x: 400, y: 372 });
  });

  it('never covers a reached node: below-right neighbour sends it left', () => {
    // the e2e board: customers-db sits where "below" and "right" would land
    expect(peekPosition(anchor, [node(620, 400), node(840, 520)], size, bounds)).toEqual({ x: 88, y: 300 });
  });

  it('skips a side that does not fit, then clamps the least bad one', () => {
    const low = { ...anchor, y: 800 }; // only above has room
    expect(peekPosition(low, [], size, bounds)).toEqual({ x: 400, y: 638 });
    const cramped = { left: 0, top: 0, right: 500, bottom: 300 };
    expect(peekPosition({ x: 100, y: 100, w: 300, h: 100 }, [], size, cramped)).toEqual({ x: 100, y: 150 });
  });
});
