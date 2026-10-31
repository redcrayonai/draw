import { describe, expect, it } from 'vitest';
import { makeMarker, markerKey, threatMarker } from './board-marker';
import type { ThreatView } from './threats-view';

const t = (over: Partial<ThreatView> = {}): ThreatView => ({
  id: 1n, anchorId: 1n, stage: 'vulnerable', severity: 'high', title: 'CVE-1', summary: 's', cvss: '', package: '', fixedIn: '',
  flags: [], source: null, author: 'a', createdAt: new Date(0), containedBy: '', containedAt: null, contained: false, ...over,
});

describe('threatMarker', () => {
  it('open compromised is red and pulses', () => {
    expect(threatMarker([t({ stage: 'compromised', severity: 'low' })], 'auth')).toMatchObject({ tone: 'red', pulse: true, count: 1 });
  });
  it('vulnerable high is red without a pulse; critical too', () => {
    expect(threatMarker([t()], 'auth')).toMatchObject({ tone: 'red', pulse: false });
    expect(threatMarker([t({ severity: 'critical' })], 'auth')).toMatchObject({ tone: 'red', pulse: false });
  });
  it('vulnerable medium and low are amber', () => {
    expect(threatMarker([t({ severity: 'medium' })], 'auth').tone).toBe('amber');
    expect(threatMarker([t({ severity: 'low' })], 'auth').tone).toBe('amber');
  });
  it('all contained is muted, no pulse, even when compromised', () => {
    expect(threatMarker([t({ stage: 'compromised', contained: true, containedBy: 'x' })], 'auth')).toMatchObject({ tone: 'muted', pulse: false });
  });
  it('an open threat outranks a contained one', () => {
    const m = threatMarker([t({ id: 1n, stage: 'compromised', contained: true, containedBy: 'x' }), t({ id: 2n, severity: 'low' })], 'auth');
    expect(m.tone).toBe('amber');
  });
  it('counts the threats and writes the exact label', () => {
    expect(threatMarker([t(), t({ id: 2n, severity: 'low' })], 'auth')).toMatchObject({ count: 2, label: 'Threat on auth: CVE-1, high, vulnerable, and 1 more' });
    expect(threatMarker([t({ stage: 'compromised' })], 'auth').label).toBe('Threat on auth: CVE-1, high, compromised');
    expect(threatMarker([t({ contained: true, containedBy: 'x' })], 'auth').label).toBe('Threat on auth: CVE-1, high, contained');
  });
});

describe('makeMarker', () => {
  const spec = threatMarker([t({ stage: 'compromised' })], 'auth');
  it('is a focusable button, pulse class only when pulsing', () => {
    const g = makeMarker(spec);
    expect(g.getAttribute('role')).toBe('button');
    expect(g.getAttribute('tabindex')).toBe('0');
    expect(g.getAttribute('aria-label')).toBe(spec.label);
    expect(g.classList.contains('board-marker') && g.classList.contains('tone-red') && g.classList.contains('pulse')).toBe(true);
    expect(makeMarker({ ...spec, pulse: false }).classList.contains('pulse')).toBe(false);
  });
  it('shows a count only for two or more', () => {
    expect(makeMarker(spec).querySelector('.board-marker-count')).toBeNull();
    expect(makeMarker({ ...spec, count: 3 }).querySelector('.board-marker-count')?.textContent).toBe('3');
  });
  it('keys on everything it draws', () => {
    expect(markerKey(spec)).not.toBe(markerKey({ ...spec, count: 2 }));
    expect(markerKey(spec)).toBe(markerKey({ ...spec }));
  });
});
