import { describe, expect, it, vi } from 'vitest';
import type { ThreatView } from './threats-view';
import { renderThreats, threatRow, threatSignature } from './threat-inspector';

const view = (o: Partial<ThreatView> = {}): ThreatView => ({
  id: 1n, anchorId: 10n, stage: 'compromised', severity: 'critical', title: 'log4shell in auth-svc', summary: 'RCE through the logger.',
  cvss: '10.0', package: 'log4j-core', fixedIn: '9.0.3', flags: ['exploited'], source: { system: 'Trivy', ref: 'CVE-1', url: 'https://x.test/1' },
  author: 'agent', createdAt: new Date(0), containedBy: '', containedAt: null, contained: false, ...o,
});

describe('threatRow', () => {
  it('a dot in the marker tone, the title and severity · cvss', () => {
    const r = threatRow(view(), true, () => {});
    expect(r.className).toBe('th-row tone-red');
    expect(r.getAttribute('aria-pressed')).toBe('true');
    expect(r.querySelector('.th-row-title')!.textContent).toBe('log4shell in auth-svc');
    expect(r.querySelector('.th-row-meta')!.textContent).toBe('critical · 10.0');
    expect(threatRow(view({ stage: 'vulnerable', severity: 'medium', cvss: '' }), false, () => {}).className).toBe('th-row tone-amber');
    expect(threatRow(view({ cvss: '' }), false, () => {}).querySelector('.th-row-meta')!.textContent).toBe('critical');
    const done = threatRow(view({ contained: true, containedBy: 'bob' }), false, () => {});
    expect(done.className).toBe('th-row tone-muted');
    expect(done.querySelector('.th-row-meta')!.textContent).toBe('contained');
  });

  it('puts user text in the DOM as text', () => {
    const r = threatRow(view({ title: '<img src=x onerror=alert(1)>' }), false, () => {});
    expect(r.querySelector('img')).toBeNull();
    expect(r.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('renderThreats', () => {
  it('one row per threat; a row opens it', () => {
    const openCard = vi.fn();
    const [list, hint] = renderThreats([view(), view({ id: 2n, title: 'b' })], { openCard });
    const rows = list.querySelectorAll<HTMLButtonElement>('.th-row');
    expect(rows).toHaveLength(2);
    rows[1].click();
    expect(openCard).toHaveBeenCalledWith(2n);
    expect(hint.textContent).toBe('Open a threat to see what it reaches.');
  });
});

describe('threatSignature', () => {
  it('changes with what the rows show', () => {
    const k = threatSignature([view()]);
    expect(threatSignature([view()])).toBe(k);
    expect(threatSignature([view({ contained: true })])).not.toBe(k);
    expect(threatSignature([view({ severity: 'high' })])).not.toBe(k);
    expect(threatSignature([view({ summary: 'other' })])).toBe(k); // the rows do not show it
  });
});
