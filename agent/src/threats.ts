/**
 * Threat tools (spec 2026-10-16): the input shapes, reducer arguments,
 * get_board summary and tool texts of the hosted MCP server (mcp/src/tools.ts).
 */
import { z } from 'zod';
import {
  MAX_FLAGS,
  MAX_FLAG_CHARS,
  MAX_SOURCE_CHARS,
  MAX_THREAT_AUTHOR,
  MAX_THREAT_CVSS,
  MAX_THREAT_FIXED_IN,
  MAX_THREAT_PACKAGE,
  MAX_THREAT_SUMMARY,
  MAX_THREAT_TITLE,
  STAGES,
  THREAT_SEVERITIES,
  type Stage,
  type ThreatSeverity,
} from '../../module/src/threats';

const id = z.string().regex(/^\d+$/).describe('numeric id as a string');
const text = z.string().min(1).max(MAX_SOURCE_CHARS);

const threat = {
  stage: z.enum(STAGES as [Stage, ...Stage[]]).describe('compromised: a SIEM alert says it was attacked; vulnerable: a scanner says it could be'),
  severity: z.enum(THREAT_SEVERITIES as [ThreatSeverity, ...ThreatSeverity[]]).describe('critical, high, medium or low (lower-case; map a scanner UNKNOWN to low)'),
  title: z.string().min(1).max(MAX_THREAT_TITLE).describe('the CVE id or alert name, e.g. "CVE-2026-31337"'),
  summary: z.string().min(1).max(MAX_THREAT_SUMMARY).describe('one plain line: what is wrong and how it can be used'),
  cvss: z.string().max(MAX_THREAT_CVSS).optional().describe('CVSS score, e.g. "9.8"'),
  package: z.string().max(MAX_THREAT_PACKAGE).optional().describe('the affected package and range, e.g. "jsonwebtoken < 9.0.3"'),
  fixedIn: z.string().max(MAX_THREAT_FIXED_IN).optional().describe('the first fixed version, e.g. "9.0.3"'),
  flags: z.array(z.string().min(1).max(MAX_FLAG_CHARS)).max(MAX_FLAGS).optional().describe('short tags, e.g. ["KEV", "exploit public"]'),
  source: z
    .object({ system: text, ref: text, url: z.string().max(MAX_SOURCE_CHARS).startsWith('https://').optional() })
    .strict()
    .optional()
    .describe('where the finding came from, e.g. { system: "Splunk", ref: "notable #48213" }; url must start with https://'),
};

export const threatInput = {
  anchorId: id.describe('the service, datastore or external node that is affected'),
  ...threat,
  author: z.string().max(MAX_THREAT_AUTHOR).optional(),
};

export const threatUpdateInput = {
  threatId: id,
  stage: threat.stage.optional(),
  severity: threat.severity.optional(),
  title: threat.title.optional(),
  summary: threat.summary.optional(),
  cvss: threat.cvss,
  package: threat.package,
  fixedIn: threat.fixedIn,
  flags: threat.flags,
  source: threat.source,
};

type ThreatInput = z.infer<z.ZodObject<typeof threatInput>>;
type ThreatUpdateInput = z.infer<z.ZodObject<typeof threatUpdateInput>>;

const json = (v: unknown) => (v === undefined ? '' : JSON.stringify(v));
const maybe = (v: unknown) => (v === undefined ? undefined : JSON.stringify(v));

export function addThreatArgs(boardId: bigint, input: ThreatInput, author: string) {
  return {
    boardId,
    anchorId: BigInt(input.anchorId),
    stage: input.stage,
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    cvss: input.cvss ?? '',
    package: input.package ?? '',
    fixedIn: input.fixedIn ?? '',
    flags: json(input.flags),
    source: json(input.source),
    author,
  };
}

/** Fields left out stay undefined: the reducer keeps their stored value. */
export function updateThreatArgs(input: ThreatUpdateInput) {
  return {
    id: BigInt(input.threatId),
    stage: input.stage,
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    cvss: input.cvss,
    package: input.package,
    fixedIn: input.fixedIn,
    flags: maybe(input.flags),
    source: maybe(input.source),
  };
}

export interface ThreatRow {
  id: bigint;
  anchorId: bigint;
  stage: string;
  severity: string;
  title: string;
  containedBy: string;
}

export interface ThreatSummary {
  id: string;
  anchorId: string;
  stage: Stage;
  severity: ThreatSeverity;
  title: string;
  contained: boolean;
}

/** get_board's threats, or undefined (left out of the JSON) when the board has none. */
export function threatSummaries(rows: ThreatRow[]): ThreatSummary[] | undefined {
  return rows.length === 0
    ? undefined
    : [...rows]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map(r => ({
          id: String(r.id),
          anchorId: String(r.anchorId),
          stage: r.stage as Stage,
          severity: r.severity as ThreatSeverity,
          title: r.title,
          contained: r.containedBy !== '',
        }));
}

export const ADD_THREAT_DESCRIPTION =
  'Flag a service, datastore or external node as vulnerable or compromised so the reviewer sees its blast radius on the board: the node shows a hazard marker, and opening it plays the damage over the drawn edges. ' +
  'Use stage compromised when a SIEM alert says the node was attacked; use stage vulnerable for a scanner finding (Trivy, Grype). ' +
  'A scan lists hundreds of CVEs: add only critical or high findings that have a fix or are on the KEV list, at most 10 per node; one call is one CVE or one alert. ' +
  'Severity is critical, high, medium or low in lower-case: map a scanner UNKNOWN to low. ' +
  'The anchor must be a service, datastore or external node on this board, and only board members can see or change threats, or the call is refused. ' +
  'Title is 1 to 120 characters and summary 1 to 200; flags are at most 6 tags of 24 characters; source url must start with https://. Returns "committed id=<n>".';

export const UPDATE_THREAT_DESCRIPTION =
  'Change a threat by id (ids come from get_board threats or the add_threat result). Fields left out keep their value. ' +
  'The stage can rise to compromised, never fall: a compromised threat cannot go back to vulnerable, so remove it and add a new one.';

export const REMOVE_THREAT_DESCRIPTION = 'Delete one threat by id (ids come from get_board threats). Use it when the finding was wrong.';
