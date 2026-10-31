// Threats as the canvas shows them: one pass over the threat rows gives the
// per-node list (worst first) and the counts. Rebuilt on table change.
import { parseFlags, parseSource, severityRank, type Stage, type ThreatSeverity, type ThreatSource } from '../../module/src/threats';
import type { Threat as ThreatRow } from './module_bindings/types';

export interface ThreatView {
  id: bigint; anchorId: bigint; stage: Stage; severity: ThreatSeverity; title: string; summary: string;
  cvss: string; package: string; fixedIn: string; flags: string[]; source: ThreatSource | null; author: string;
  createdAt: Date; containedBy: string; containedAt: Date | null; contained: boolean;
}
export interface ThreatIndex { byAnchor: Map<bigint, ThreatView[]>; /* worstThreat order */ open: number; contained: number }

const date = (t: { microsSinceUnixEpoch: bigint }) => new Date(Number(t.microsSinceUnixEpoch / 1000n));
// A bad row must not throw out of the index: unparsable is empty.
const safe = <T>(f: () => T, d: T): T => { try { return f(); } catch { return d; } };

function toView(r: ThreatRow): ThreatView {
  const contained = r.containedBy !== '';
  return {
    id: r.id, anchorId: r.anchorId, stage: r.stage as Stage, severity: r.severity as ThreatSeverity, title: r.title, summary: r.summary,
    cvss: r.cvss, package: r.package, fixedIn: r.fixedIn, flags: safe(() => parseFlags(r.flags), []), source: safe(() => parseSource(r.source), null),
    author: r.author, createdAt: date(r.createdAt), containedBy: r.containedBy, containedAt: contained ? date(r.containedAt) : null, contained,
  };
}

// The same keys as worstThreat in module/src/threats.ts, plus id so the order is stable.
const key = (t: ThreatView) => [t.contained ? 1 : 0, t.stage === 'compromised' ? 0 : 1, severityRank(t.severity)];
function worstFirst(a: ThreatView, b: ThreatView): number {
  const x = key(a), y = key(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function buildThreatIndex(rows: Iterable<ThreatRow>): ThreatIndex {
  const byAnchor = new Map<bigint, ThreatView[]>();
  let open = 0, contained = 0;
  for (const r of rows) {
    const t = toView(r);
    if (t.contained) contained++; else open++;
    const l = byAnchor.get(t.anchorId);
    if (l) l.push(t); else byAnchor.set(t.anchorId, [t]);
  }
  for (const l of byAnchor.values()) l.sort(worstFirst);
  return { byAnchor, open, contained };
}

/** Counts every threat; those whose anchor is not drawn (hidden, spec T5) are named, as they have no marker. */
export function threatRailText(index: ThreatIndex, labelOf: (id: bigint) => string, visibleIds?: ReadonlySet<bigint>): string {
  const n = index.open + index.contained;
  if (n === 0) return '';
  let hidden = 0;
  if (visibleIds) for (const [a, list] of index.byAnchor) if (!visibleIds.has(a)) hidden += list.length;
  const tail = hidden === 0 ? '' : hidden === 1 ? ' · 1 on a hidden node' : ` · ${hidden} on hidden nodes`;
  if (n === 1 && index.open === 1) {
    const t = [...index.byAnchor.values()][0][0];
    return `1 threat · ${labelOf(t.anchorId)} ${t.stage}${tail}`;
  }
  return `${n} threat${n === 1 ? '' : 's'}${index.contained > 0 ? ` · ${index.contained} contained` : ''}${tail}`;
}

// shortcut: matches PII in the node's own words; add a data-class field when a PII store goes unflagged because its sublabel and doc never say PII
export function looksPii(n: { sublabel: string; doc: string }): boolean {
  return /\bPII\b/i.test(`${n.sublabel} ${n.doc}`);
}
