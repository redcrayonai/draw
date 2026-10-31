import { describe, expect, it, vi } from 'vitest';
import { blastRadius, type Blast } from './blast';
import { renderThreatCard, threatCardKey, threatCardStillValid, type ThreatCardActions, type ThreatCardModel } from './threat-card';
import { buildThreatIndex, type ThreatView } from './threats-view';
import type { Threat } from './module_bindings/types';

// The mockup graph (blast.test.ts): auth-svc is the source.
const N = { gateway: 1n, auth: 2n, users: 3n, sess: 4n, pay: 5n, orders: 6n, stripe: 7n, odb: 8n, search: 9n };
const names: Record<string, string> = { 1: 'gateway', 2: 'auth-svc', 3: 'users-db', 4: 'sessions', 5: 'payments', 6: 'orders', 7: 'Stripe', 8: 'orders-db', 9: 'search' };
const labelOf = (id: bigint) => names[String(id)];
const e = (id: number, fromNode: bigint, toNode: bigint, label = '') => ({ id: BigInt(id), fromNode, toNode, label });
const edges = [
  e(1, N.gateway, N.auth, 'verify'), e(2, N.auth, N.users, 'reads'), e(3, N.auth, N.sess, 'writes'),
  e(4, N.pay, N.auth, 'verify'), e(5, N.orders, N.auth, 'verify'), e(6, N.pay, N.stripe),
  e(7, N.orders, N.odb), e(8, N.gateway, N.search),
];
const blast = (): Blast => blastRadius(N.auth, Object.values(N), edges, labelOf, { direction: 'both', depth: 2 });

const CREATED = new Date(Date.now() - 3 * 60_000);
const threat = (o: Partial<ThreatView> = {}): ThreatView => ({
  id: 1n, anchorId: N.auth, stage: 'compromised', severity: 'critical', title: 'CVE-2026-31337',
  summary: 'jsonwebtoken < 9.0.3 lets anyone forge tokens.', cvss: '9.8', package: 'jsonwebtoken', fixedIn: '9.0.3',
  flags: ['KEV', 'exploit public'], source: { system: 'Splunk', ref: 'notable #48213', url: 'https://splunk.example/n/48213' },
  author: 'claude-code', createdAt: CREATED, containedBy: '', containedAt: null, contained: false, ...o,
});

const actions = (): ThreatCardActions => ({
  selectThreat: vi.fn(), setDirection: vi.fn(), setDepth: vi.fn(), hoverNode: vi.fn(),
  playSpread: vi.fn(), setContained: vi.fn().mockResolvedValue(undefined),
});
const model = (o: Partial<ThreatCardModel> = {}): ThreatCardModel => ({
  threats: [threat()], selected: 1n, blast: blast(), direction: 'both', depth: 2,
  nodeLabel: labelOf, nodePii: id => id === N.users, canContain: true, ...o,
});
const tiers = (el: HTMLElement) =>
  [...el.querySelectorAll('.tc-tier')].map(t => [t.querySelector('.tc-tier-label')!.textContent, t.querySelector('.tc-count')!.textContent]);

describe('renderThreatCard', () => {
  it('detail, reach tiers and foot', () => {
    const el = renderThreatCard(model(), actions());
    expect(el.querySelector('.tc-title')!.textContent).toBe('CVE-2026-31337');
    expect([...el.querySelectorAll('.tc-meta > *')].map(c => c.textContent)).toEqual(['critical', 'compromised', 'Splunk notable #48213', '3 min ago', 'noted by claude-code']);
    expect(el.querySelector('.tc-sev')!.className).toBe('tc-sev tone-red');
    expect(el.querySelector('.tc-summary')!.textContent).toBe('jsonwebtoken < 9.0.3 lets anyone forge tokens.');
    expect(el.querySelector('.tc-pkg')!.textContent).toBe('jsonwebtoken · CVSS 9.8 · fix 9.0.3');
    expect(el.querySelector('.tc-tags')!.textContent).toBe('KEV · exploit public');
    expect(tiers(el)).toEqual([['Exposed · 1 hop', '5'], ['At risk · 2 hops', '3'], ['Clear', '0']]);
    expect(el.querySelector('.tc-clear .tc-caveat')!.textContent).toBe('Read from the drawn edges, not verified.');
    expect(el.querySelector('.tc-play')!.textContent).toBe('Play spreadP');
    expect(el.querySelector('.th-list')).toBeNull(); // one threat: no list
  });

  it('a vulnerable threat says exposed if exploited', () => {
    const el = renderThreatCard(model({ threats: [threat({ stage: 'vulnerable' })] }), actions());
    expect(tiers(el)[0]).toEqual(['Exposed if exploited · 1 hop', '5']);
    expect([...el.querySelectorAll('.tc-meta > *')].slice(0, 2).map(c => c.textContent)).toEqual(['critical', 'vulnerable']);
    // one threat, no list: the severity still shows, in the marker's tone (vulnerable critical is red)
    expect(el.querySelector('.tc-sev')!.className).toBe('tc-sev tone-red');
    expect(renderThreatCard(model({ threats: [threat({ stage: 'vulnerable', severity: 'medium' })] }), actions()).querySelector('.tc-sev')!.className).toBe('tc-sev tone-amber');
  });

  it('rows with PII and why light their node on hover, focus and click; controls call back', () => {
    const a = actions();
    const el = renderThreatCard(model(), a);
    const users = [...el.querySelectorAll<HTMLButtonElement>('.tc-row')].find(r => r.textContent!.includes('users-db'))!;
    expect(users.querySelector('.tc-pii')).not.toBeNull();
    expect(users.querySelector('.tc-why')!.textContent).toBe('reads');
    expect(el.querySelectorAll('.tc-row .tc-pii')).toHaveLength(1);
    users.dispatchEvent(new MouseEvent('mouseenter'));
    expect(a.hoverNode).toHaveBeenCalledWith(N.users);
    users.dispatchEvent(new MouseEvent('mouseleave'));
    expect(a.hoverNode).toHaveBeenLastCalledWith(null);
    users.click();
    expect(a.hoverNode).toHaveBeenLastCalledWith(N.users);
    const btn = (text: string) => [...el.querySelectorAll<HTMLButtonElement>('.tc-seg button')].find(b => b.textContent === text)!;
    expect(btn('both').getAttribute('aria-pressed')).toBe('true');
    expect(btn('2').getAttribute('aria-pressed')).toBe('true');
    expect(btn('reaches').getAttribute('aria-pressed')).toBe('false');
    btn('trusts it').click();
    expect(a.setDirection).toHaveBeenCalledWith('trusts');
    btn('all').click();
    expect(a.setDepth).toHaveBeenCalledWith('all');
    el.querySelector<HTMLButtonElement>('.tc-play')!.click();
    expect(a.playSpread).toHaveBeenCalled();
  });

  it('contain button: absent without canContain, toggles with it', async () => {
    expect(renderThreatCard(model({ canContain: false }), actions()).querySelector('.tc-contain')).toBeNull();
    const a = actions();
    const el = renderThreatCard(model(), a);
    const b = el.querySelector<HTMLButtonElement>('.tc-contain')!;
    expect(b.textContent).toBe('Mark contained');
    b.click();
    expect(a.setContained).toHaveBeenCalledWith(1n, true);
    const reopen = renderThreatCard(model({ threats: [threat({ contained: true, containedBy: 'alan', containedAt: CREATED })] }), actions());
    expect(reopen.querySelector('.tc-contain')!.textContent).toBe('Reopen');
    expect(reopen.querySelectorAll('.tc-meta > *')[1].textContent).toBe('compromised, contained');
    expect(reopen.querySelector('.tc-contained')!.textContent).toBe('contained by alan · 3 min ago');
  });

  it('source is a safe link, built from text', () => {
    const el = renderThreatCard(model({ threats: [threat({ author: '<img src=x onerror=alert(1)>' })] }), actions());
    const a = el.querySelector<HTMLAnchorElement>('a.tc-src')!;
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('href')).toBe('https://splunk.example/n/48213');
    expect(el.querySelector('.tc-meta')!.textContent).toContain('noted by <img src=x onerror=alert(1)>');
    expect(el.querySelector('img')).toBeNull();
    const plain = renderThreatCard(model({ threats: [threat({ source: { system: 'Trivy', ref: 'r1' } })] }), actions());
    expect(plain.querySelector('a.tc-src')).toBeNull();
    expect(plain.querySelector('.tc-src')!.textContent).toBe('Trivy r1');
    const bad = renderThreatCard(model({ threats: [threat({ source: { system: 'S', ref: 'r', url: 'javascript:alert(1)' } })] }), actions());
    expect(bad.querySelector('a')).toBeNull();
  });

  it('several threats: a J/K list, the selected one pressed and shown', () => {
    const a = actions();
    const el = renderThreatCard(model({ threats: [threat(), threat({ id: 2n, title: 'second' })], selected: 2n }), a);
    expect(el.querySelector('.tc-title')!.textContent).toBe('second');
    expect(el.querySelector('.tc-listhead')!.textContent).toBe('2 threatsJK');
    const rows = [...el.querySelectorAll<HTMLButtonElement>('.th-row')];
    expect(rows.map(r => r.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    rows[0].click();
    expect(a.selectThreat).toHaveBeenCalledWith(1n);
  });

  it('every control carries a stable data-key, unique in the panel', () => {
    const el = renderThreatCard(model({ threats: [threat(), threat({ id: 2n })] }), actions());
    const keys = [...el.querySelectorAll<HTMLElement>('button, a')].map(b => b.dataset.key);
    expect(keys.every(k => k !== undefined && k !== '')).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(['threat:1', 'threat:2', 'src', 'seg:both', 'seg:2', `node:${N.users}`, 'play', 'contain']));
  });

  it('with no threats returns an empty element without throwing', () => {
    const el = renderThreatCard(model({ threats: [] }), actions());
    expect(el.childElementCount).toBe(0);
  });
});

describe('threatCardKey', () => {
  it('is stable across rebuilt inputs and changes with what the card draws', () => {
    const k = threatCardKey(model());
    expect(threatCardKey(model({ blast: blast(), threats: [threat()] }))).toBe(k); // a fresh walk of the same edges
    expect(threatCardKey(model({ nodeLabel: id => (id === N.users ? 'customers-db' : labelOf(id)) }))).not.toBe(k);
    expect(threatCardKey(model({ nodePii: () => false }))).not.toBe(k);
    expect(threatCardKey(model({ selected: 2n }))).not.toBe(k);
    expect(threatCardKey(model({ depth: 'all' }))).not.toBe(k);
    expect(threatCardKey(model({ canContain: false }))).not.toBe(k);
    expect(threatCardKey(model({ threats: [threat({ contained: true, containedBy: 'alan' })] }))).not.toBe(k);
    // an unlisted node's label (say a route waypoint renamed) is not in the card
    expect(threatCardKey(model({ nodeLabel: id => (id === 99n ? 'other' : labelOf(id)) }))).toBe(k);
  });
});

describe('threatCardStillValid', () => {
  const ts = (ms: number) => ({ microsSinceUnixEpoch: BigInt(ms) * 1000n }) as unknown as Threat['createdAt'];
  const row = (o: Partial<Threat>): Threat => ({
    id: 1n, boardId: 1n, anchorId: N.auth, stage: 'compromised', severity: 'critical', title: 't', summary: 's', cvss: '', package: '', fixedIn: '',
    flags: '', source: '', author: 'a', createdAt: ts(1000), containedBy: '', containedAt: ts(0), ...o,
  }) as Threat;
  const index = buildThreatIndex([row({}), row({ id: 2n })]);
  const visible = new Set(Object.values(N));
  const open = { anchorId: N.auth, threatId: 2n };

  it('is true while the threat and its visible anchor remain', () => {
    expect(threatCardStillValid(open, index, visible)).toBe(true);
  });
  it('is false when the threat was removed', () => {
    expect(threatCardStillValid(open, buildThreatIndex([row({})]), visible)).toBe(false);
    expect(threatCardStillValid(open, buildThreatIndex([]), visible)).toBe(false);
  });
  it('is false when the anchor is hidden or deleted', () => {
    expect(threatCardStillValid(open, index, new Set([N.users]))).toBe(false);
  });
  it('is false with nothing open', () => {
    expect(threatCardStillValid(null, index, visible)).toBe(false);
  });
});
