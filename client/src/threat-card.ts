// The open threat, docked in the node inspector: the anchor's threats, the selected one's detail,
// what it reaches and the actions. The board stays clear so the spread plays where it can be seen.
// Pure DOM from a model; every user or agent string is textContent.
import type { Blast, Depth, Direction } from './blast';
import type { ThreatIndex, ThreatView } from './threats-view';
import { threatRow } from './threat-inspector';
import { threatMarker } from './board-marker';
import { relativeTime } from './session-rail';

export interface ThreatCardModel {
  threats: ThreatView[]; selected: bigint; blast: Blast;
  direction: Direction; depth: Depth; nodeLabel(id: bigint): string; nodePii(id: bigint): boolean; canContain: boolean;
}
export interface ThreatCardActions {
  selectThreat(id: bigint): void; setDirection(d: Direction): void; setDepth(d: Depth): void;
  hoverNode(id: bigint | null): void; playSpread(): void;
  setContained(id: bigint, contained: boolean): Promise<void>;
}

/** The open threat still exists on a visible anchor; otherwise main closes it. */
export function threatCardStillValid(open: { anchorId: bigint; threatId: bigint } | null, index: ThreatIndex, visibleNodeIds: ReadonlySet<bigint>): boolean {
  return open !== null && visibleNodeIds.has(open.anchorId) && (index.byAnchor.get(open.anchorId)?.some(t => t.id === open.threatId) ?? false);
}

/** Everything the panel draws, except the ticking source time: main repaints only when it changes. */
export function threatCardKey(m: ThreatCardModel): string {
  const listed = [...m.blast.nodes].map(([id, n]) => [id, n.hop, n.why, m.nodeLabel(id), m.nodePii(id)]);
  return JSON.stringify(
    [m.threats, m.selected, listed, m.blast.clear.length, m.direction, m.depth, m.canContain],
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
/** key: a stable name main restores focus by after a repaint. */
function button(cls: string, text: string, onClick: () => void, key: string): HTMLButtonElement {
  const b = h('button', cls, text);
  b.type = 'button';
  b.dataset.key = key;
  b.addEventListener('click', onClick);
  return b;
}
const kbd = (key: string) => h('kbd', 'tc-kbd', key);

const DIRECTIONS: [Direction, string][] = [['reaches', 'reaches'], ['trusts', 'trusts it'], ['both', 'both']];
const DEPTHS: Depth[] = [1, 2, 3, 'all'];

function segmented<T>(label: string, options: [T, string][], current: T, pick: (v: T) => void): HTMLElement {
  // Unique across both groups: no direction is also a depth.
  const group = h('div', 'tc-seg');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  for (const [v, text] of options) {
    const b = button('', text, () => pick(v), `seg:${String(v)}`);
    b.setAttribute('aria-pressed', String(v === current));
    group.append(b);
  }
  return group;
}

export function renderThreatCard(m: ThreatCardModel, a: ThreatCardActions): HTMLElement {
  const root = h('div', 'tc');
  const t = m.threats.find(x => x.id === m.selected) ?? m.threats[0];
  if (t === undefined) return root;
  root.classList.add(`stage-${t.stage}`);

  if (m.threats.length > 1) {
    const head = h('div', 'tc-listhead');
    head.append(h('span', '', `${m.threats.length} threats`), h('span', 'tc-keys'));
    head.lastElementChild!.append(kbd('J'), kbd('K'));
    const list = h('div', 'th-list');
    list.append(...m.threats.map(x => {
      const row = threatRow(x, x.id === t.id, () => a.selectThreat(x.id));
      row.dataset.key = `threat:${x.id}`;
      return row;
    }));
    root.append(head, list);
  }

  const detail = h('div', 'tc-detail');
  detail.append(h('h3', 'tc-title', t.title));
  // The stage word is always shown: reduced motion hides the only marker difference.
  const meta = h('div', 'tc-meta');
  // Severity here too: with one threat there is no list row to show it.
  meta.append(h('span', `tc-sev tone-${threatMarker([t], '').tone}`, t.severity), h('span', '', t.contained ? `${t.stage}, contained` : t.stage));
  if (t.source !== null) {
    const text = `${t.source.system} ${t.source.ref}`;
    if (t.source.url !== undefined && t.source.url.startsWith('https://')) {
      const link = h('a', 'tc-src', text);
      link.dataset.key = 'src';
      link.href = t.source.url;
      link.rel = 'noopener noreferrer';
      link.target = '_blank';
      meta.append(link);
    } else meta.append(h('span', 'tc-src', text));
  }
  meta.append(h('span', '', relativeTime(t.createdAt.getTime(), Date.now())));
  if (t.author !== '') meta.append(h('span', '', `noted by ${t.author}`));
  detail.append(meta, h('p', 'tc-summary', t.summary));
  const pkg = [t.package, t.cvss === '' ? '' : `CVSS ${t.cvss}`, t.fixedIn === '' ? '' : `fix ${t.fixedIn}`].filter(s => s !== '').join(' · ');
  if (pkg !== '') detail.append(h('div', 'tc-pkg', pkg));
  if (t.flags.length > 0) detail.append(h('div', 'tc-tags', t.flags.join(' · ')));
  if (t.contained) detail.append(h('div', 'tc-contained', `contained by ${t.containedBy}${t.containedAt ? ` · ${relativeTime(t.containedAt.getTime(), Date.now())}` : ''}`));
  root.append(detail);

  const reach = h('div', 'tc-reach');
  const reachHead = h('div', 'tc-reachhead');
  reachHead.append(
    h('span', '', 'Reach'),
    segmented('Direction', DIRECTIONS, m.direction, a.setDirection),
    segmented('Depth', DEPTHS.map(d => [d, String(d)] as [Depth, string]), m.depth, a.setDepth),
  );
  reach.append(reachHead);
  const byHop = new Map<number, bigint[]>();
  for (const [id, n] of m.blast.nodes) {
    const l = byHop.get(n.hop);
    if (l) l.push(id); else byHop.set(n.hop, [id]);
  }
  for (const hop of [...byHop.keys()].sort((x, y) => x - y)) {
    const ids = byHop.get(hop)!;
    const label = hop === 1 ? (t.stage === 'vulnerable' ? 'Exposed if exploited · 1 hop' : 'Exposed · 1 hop') : `At risk · ${hop} hops`;
    const tier = tierEl(`tc-tier ${hop === 1 ? 'hop1' : 'hopn'}`, label, ids.length);
    for (const id of ids) {
      // A row lights its node on the board; it never moves the selection, which would close the threat.
      const row = button('tc-row', '', () => a.hoverNode(id), `node:${id}`);
      row.append(h('span', 'tc-row-label', m.nodeLabel(id)));
      if (m.nodePii(id)) row.append(h('span', 'tc-pii', 'PII'));
      row.append(h('span', 'tc-why', m.blast.nodes.get(id)!.why));
      row.addEventListener('mouseenter', () => a.hoverNode(id));
      row.addEventListener('focus', () => a.hoverNode(id));
      row.addEventListener('mouseleave', () => a.hoverNode(null));
      row.addEventListener('blur', () => a.hoverNode(null));
      tier.append(row);
    }
    reach.append(tier);
  }
  // Said, not hovered: a missing edge is not proof of safety (spec anti-goal "false calm").
  const clear = tierEl('tc-tier tc-clear', 'Clear', m.blast.clear.length);
  clear.append(h('p', 'tc-caveat', 'Read from the drawn edges, not verified.'));
  reach.append(clear);
  root.append(reach);

  const foot = h('div', 'tc-foot');
  const play = button('tc-play', 'Play spread', a.playSpread, 'play');
  play.append(kbd('P'));
  foot.append(play);
  if (m.canContain) {
    const contain = button('tc-contain', t.contained ? 'Reopen' : 'Mark contained', () => {
      contain.disabled = true;
      void a.setContained(t.id, !t.contained).finally(() => { contain.disabled = false; });
    }, 'contain');
    foot.append(contain);
  }
  root.append(foot);
  return root;
}

function tierEl(cls: string, label: string, count: number): HTMLElement {
  const tier = h('div', cls);
  const head = h('div', 'tc-tier-head');
  head.append(h('span', 'tc-tier-label', label), h('span', 'tc-count', String(count)));
  tier.append(head);
  return tier;
}
