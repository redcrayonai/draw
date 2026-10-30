// Threat contracts: the single source of truth for threat flags (blast radius spec 2026-10-16).
// Zero imports, erasable TypeScript only, ES2021 APIs only: the module bundle, the client,
// the agent and `node --experimental-strip-types` all load this file as is.

export type Stage = 'vulnerable' | 'compromised';
export type ThreatSeverity = 'critical' | 'high' | 'medium' | 'low';
export interface ThreatSource { system: string; ref: string; url?: string }

/** Lowest first: a stage only rises. */
export const STAGES: readonly Stage[] = ['vulnerable', 'compromised'];
/** Worst first: the index is the rank. */
export const THREAT_SEVERITIES: readonly ThreatSeverity[] = ['critical', 'high', 'medium', 'low'];

export const MAX_THREAT_TITLE = 120;
export const MAX_THREAT_SUMMARY = 200;
export const MAX_FLAGS = 6;
export const MAX_FLAG_CHARS = 24;
export const MAX_SOURCE_CHARS = 200;
export const MAX_THREAT_CVSS = 8;
export const MAX_THREAT_PACKAGE = 120;
export const MAX_THREAT_FIXED_IN = 40;
export const MAX_THREAT_AUTHOR = 80;

export const THREAT_STAGE_RULE = 'threat stage must be vulnerable or compromised';
export const THREAT_SEVERITY_RULE = 'threat severity must be critical, high, medium or low';
export const THREAT_TITLE_RULE = 'threat title must be 1 to 120 characters';
export const THREAT_SUMMARY_RULE = 'threat summary must be 1 to 200 characters';
export const THREAT_JSON_RULE = 'threat flags and source must be valid JSON in the documented shape';
export const THREAT_FLAGS_RULE = 'threat flags must be at most 6 strings of 1 to 24 characters';
export const THREAT_URL_RULE = 'threat source url must start with https://';
export const THREAT_FIELD_RULE = 'threat cvss, package, fixedIn and author must be at most 8, 120, 40 and 80 characters';
export const THREAT_STAGE_LOWER_RULE = 'a compromised threat cannot go back to vulnerable; remove it and add a new one';

/** Kinds that can hold a threat and join a blast; '' is a legacy row the client reads as a service. */
const THREAT_KINDS: readonly string[] = ['', 'service', 'datastore', 'external'];
export function isThreatKind(kind: string): boolean {
  return THREAT_KINDS.indexOf(kind) >= 0;
}

export function checkStage(s: string): Stage {
  if ((STAGES as readonly string[]).indexOf(s) < 0) throw new Error(THREAT_STAGE_RULE);
  return s as Stage;
}

export function checkSeverity(s: string): ThreatSeverity {
  if ((THREAT_SEVERITIES as readonly string[]).indexOf(s) < 0) throw new Error(THREAT_SEVERITY_RULE);
  return s as ThreatSeverity;
}

export function checkThreatText(title: string, summary: string): void {
  if (title.trim() === '' || title.length > MAX_THREAT_TITLE) throw new Error(THREAT_TITLE_RULE);
  if (summary.trim() === '' || summary.length > MAX_THREAT_SUMMARY) throw new Error(THREAT_SUMMARY_RULE);
}

export function checkThreatFields(cvss: string, pkg: string, fixedIn: string, author: string): void {
  if (cvss.length > MAX_THREAT_CVSS || pkg.length > MAX_THREAT_PACKAGE || fixedIn.length > MAX_THREAT_FIXED_IN || author.length > MAX_THREAT_AUTHOR) {
    throw new Error(THREAT_FIELD_RULE);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(THREAT_JSON_RULE);
  }
}

/** '' is no flags. */
export function parseFlags(json: string): string[] {
  if (json === '') return [];
  const v = parse(json);
  if (!Array.isArray(v) || !v.every(f => typeof f === 'string')) throw new Error(THREAT_JSON_RULE);
  if (v.length > MAX_FLAGS || v.some(f => f === '' || f.length > MAX_FLAG_CHARS)) throw new Error(THREAT_FLAGS_RULE);
  return v;
}

const isText = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= MAX_SOURCE_CHARS;

/** '' is no source. */
export function parseSource(json: string): ThreatSource | null {
  if (json === '') return null;
  const v = parse(json);
  if (!isObj(v) || !isText(v.system) || !isText(v.ref)) throw new Error(THREAT_JSON_RULE);
  const source: ThreatSource = { system: v.system, ref: v.ref };
  if (v.url !== undefined) {
    if (typeof v.url !== 'string' || v.url.length > MAX_SOURCE_CHARS || !v.url.startsWith('https://')) throw new Error(THREAT_URL_RULE);
    source.url = v.url;
  }
  return source;
}

/** A stage only rises: false only for compromised to vulnerable. */
export function canRaiseStage(from: Stage, to: Stage): boolean {
  return STAGES.indexOf(to) >= STAGES.indexOf(from);
}

export function severityRank(s: ThreatSeverity): number {
  return THREAT_SEVERITIES.indexOf(s);
}

/** The threat to show on a node: open before contained, then compromised before vulnerable, then worst severity. */
export function worstThreat<T extends { stage: string; severity: string; containedBy: string }>(rows: T[]): T | undefined {
  const key = (r: T) => [r.containedBy === '' ? 0 : 1, r.stage === 'compromised' ? 0 : 1, severityRank(r.severity as ThreatSeverity)];
  let best: T | undefined;
  for (const r of rows) {
    if (best === undefined) { best = r; continue; }
    const a = key(r), b = key(best);
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) { if (a[i] < b[i]) best = r; break; }
    }
  }
  return best;
}
