import { threatMarker } from './board-marker';
import type { ThreatView } from './threats-view';

/** The threat block of the node inspector (spec 2026-10-16): one row per threat, worst first; a row opens it. Every string is textContent. */
export interface ThreatActions {
  openCard(id: bigint): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Repaint when anything the rows show changes. */
export function threatSignature(threats: ThreatView[]): string {
  return threats.map(t => [t.id, t.stage, t.severity, t.title, t.cvss, t.contained].join('|')).join('\n');
}

/** One threat as a row: a dot in the marker's tone, the title, and its severity. Shared by the list and the open panel. */
export function threatRow(t: ThreatView, pressed: boolean, onClick: () => void): HTMLButtonElement {
  const row = el('button', `th-row tone-${threatMarker([t], '').tone}`);
  row.type = 'button';
  row.setAttribute('aria-pressed', String(pressed));
  row.addEventListener('click', onClick);
  const dot = el('span', 'th-dot');
  dot.setAttribute('aria-hidden', 'true');
  row.append(dot, el('span', 'th-row-title', t.title), el('span', 'th-row-meta', t.contained ? 'contained' : t.cvss === '' ? t.severity : `${t.severity} · ${t.cvss}`));
  return row;
}

export function renderThreats(threats: ThreatView[], a: ThreatActions): HTMLElement[] {
  const list = el('div', 'th-list');
  list.append(...threats.map(t => threatRow(t, false, () => a.openCard(t.id))));
  return [list, el('div', 'th-hint', 'Open a threat to see what it reaches.')];
}
