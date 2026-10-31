// Portable board bundles (core): one board's complete persistent content as versioned JSON with
// a checksum. PLUGINS.md "Board bundle format" lists every table and why it is in or out.
// Zero spacetimedb imports: web/ and `node --experimental-strip-types` load this file as is;
// the module passes the Timestamp and Identity constructors to parseBundle.
import { sha256Hex } from './sha256';

export const BUNDLE_FORMAT = 'draw.board-bundle';
export const BUNDLE_VERSION = 1;
/** UTF-8 bytes of a whole bundle file. */
export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

type Codec = 'u64' | 'u32' | 'i32' | 'f32' | 'bool' | 'string' | 'time' | 'identity' | 'u64[]' | 'string[]' | 'u64?';
type Cols = Record<string, Codec>;

// Format v1. Each section is one board-owned table; its columns, in key order. A column left out
// is never stored: code text (edge.evidenceSnippet, codeRef.snippet), a mark's claim and lease,
// and every boardId (the restored board's). Never change v1: append a v2 and decode v1 into it.
export const SECTIONS = {
  nodes: { table: 'node', cols: { id: 'u64', label: 'string', sublabel: 'string', x: 'i32', y: 'i32', w: 'i32', h: 'i32', token: 'string', focal: 'bool', doc: 'string', hidden: 'bool', imported: 'bool', kind: 'string', shape: 'string', color: 'string', strokeStyle: 'string', size: 'string', sourceKey: 'string' } },
  edges: { table: 'edge', cols: { id: 'u64', fromNode: 'u64', toNode: 'u64', label: 'string', evidence: 'string', hidden: 'bool', imported: 'bool', color: 'string', strokeStyle: 'string', evidenceStatus: 'string', relation: 'string', latencyMs: 'f32', latencySource: 'string' } },
  edgeWeights: { table: 'edgeWeight', cols: { edgeId: 'u64', weight: 'string' } },
  edgeEvidenceHashes: { table: 'edgeEvidenceHash', cols: { edgeId: 'u64', lineHash: 'string' } },
  charts: { table: 'chart', cols: { nodeId: 'u64', type: 'string', csv: 'string', options: 'string', source: 'string', updatedAt: 'time' } },
  nodeIcons: { table: 'nodeIcon', cols: { nodeId: 'u64', icon: 'string' } },
  hideSets: { table: 'hideSet', cols: { id: 'u64', name: 'string', createdBy: 'string' } },
  hideSetMembers: { table: 'hideSetMember', cols: { setId: 'u64', targetKind: 'string', targetId: 'u64' } },
  repoFiles: { table: 'repoFile', cols: { path: 'string' } },
  codeRefs: { table: 'codeRef', cols: { id: 'u64', targetKind: 'string', targetId: 'u64', path: 'string', symbol: 'string', startLine: 'u32', endLine: 'u32', blobSha: 'string', author: 'string', checkpoint: 'u32', status: 'string' } },
  codeRefHashes: { table: 'codeRefHash', cols: { refId: 'u64', lineHashes: 'string' } },
  changeNotes: { table: 'changeNote', cols: { anchorId: 'u64', refId: 'u64', kind: 'string', severity: 'string', title: 'string', summary: 'string', steps: 'string', schema: 'string', subjects: 'string', readers: 'string', refFileSha: 'string', author: 'string', checkpoint: 'u32', reviewedBy: 'string', reviewedAt: 'time', reviewedSha: 'string' } },
  threats: { table: 'threat', cols: { anchorId: 'u64', stage: 'string', severity: 'string', title: 'string', summary: 'string', cvss: 'string', package: 'string', fixedIn: 'string', flags: 'string', source: 'string', author: 'string', createdAt: 'time', containedBy: 'string', containedAt: 'time' } },
  marks: { table: 'mark', cols: { nodeId: 'u64', nodeLabel: 'string', note: 'string', author: 'identity', round: 'u32', status: 'string', reply: 'string', files: 'string', sentAt: 'time', answeredAt: 'time' } },
  routeEvents: { table: 'routeEvent', cols: { kind: 'string', revision: 'u32', nodeId: 'u64?', nodeIds: 'u64[]', reason: 'string', checkpoint: 'u32', at: 'time' } },
  session: { table: 'session', one: true, cols: { repoRoot: 'string', baseSha: 'string', headSha: 'string', checkpoint: 'u32', coverage: 'string', startedAt: 'time', updatedAt: 'time' } },
  sessionRoute: { table: 'sessionRoute', one: true, cols: { nodeIds: 'u64[]', currentIndex: 'i32', revision: 'u32', currentCheckpoint: 'u32', updatedAt: 'time' } },
  sessionRemote: { table: 'sessionRemote', one: true, cols: { remoteUrl: 'string', pushedHead: 'string', dirtyPaths: 'string[]' } },
  tracePlayback: { table: 'tracePlayback', one: true, cols: { spans: 'string', source: 'string', title: 'string', seq: 'u32', playedAt: 'time' } },
} as const satisfies Record<string, { table: string; one?: true; cols: Cols }>;

// Every other table and why a bundle leaves it out: the coverage inventory. scripts/verify-versions-local.mjs
// fails on a published table that is in neither list, so a new board table must choose.
const AUTH = 'authorization: a restore grants only the restorer';
const LIVE = 'live presence';
const NOT_BOARD = 'not board content';
export const LEFT_OUT: Record<string, string> = {
  board: 'its name is board.name; the restored board gets a new id and link (slug)',
  architectureVersion: 'provenance in board.architecture; the restored board joins no history and branches nothing',
  architectureHistory: 'spans many boards; its repository is in board.architecture',
  historyWorkspace: AUTH, boardWorkspace: AUTH, boardGrant: AUTH, teamGrant: AUTH, agentGrant: AUTH,
  workspaceBoardGrant: AUTH, workspaceTeamGrant: AUTH, workspaceInvite: AUTH, publicBoard: AUTH,
  linkShare: 'share token', linkVisit: 'share token', chartEmbed: 'share token', chartEmbedVisit: 'share token',
  boardEmbed: 'share token', boardEmbedVisit: 'share token', guestBoard: AUTH, guestClaimOffer: AUTH, boardCreation: 'creation receipt',
  boardStats: 'derived; recomputed for the restored board', activityOutbox: 'activity feed; the restored board starts its own',
  markWaiter: LIVE, cursor: LIVE, selection: LIVE, openBoard: LIVE, markRead: "each person's read position",
  nodeTouch: 'the agent that last edited a node, which routes new marks to it: agent access',
  codeConsent: "each person's setting; it decides code text when the code is next sent",
  demoReset: NOT_BOARD, writeBudget: NOT_BOARD, libraryItem: NOT_BOARD, participant: NOT_BOARD, serviceAccount: NOT_BOARD,
  orgMember: NOT_BOARD, agentLinkOffer: NOT_BOARD, agentLink: NOT_BOARD, legacyWorkspace: NOT_BOARD,
  workspace: NOT_BOARD, workspaceAccount: NOT_BOARD, workspaceMember: NOT_BOARD, workspaceTeam: NOT_BOARD, workspaceTeamMember: NOT_BOARD,
  workspaceServiceAccount: NOT_BOARD, workspaceApiKey: NOT_BOARD, workspaceMachineIdentity: NOT_BOARD, workspaceApiKeyExpiry: NOT_BOARD,
  workspacePlugin: NOT_BOARD, boardVersion: 'the Versions index', boardVersionChunk: 'restore staging', versionCooldown: 'rate limit',
};

// Where the board came from. Provenance only: a restore never links back to these boards.
const SOURCE: Cols = { boardId: 'u64', workspaceId: 'u64', capturedAt: 'time', capturedBy: 'identity' };
const ARCHITECTURE: Cols = { assertionMode: 'string', status: 'string', historyId: 'u64', index: 'u32', ref: 'string', sha: 'string', baseBoardId: 'u64', implementedBoardId: 'u64', repository: 'string' };

type Section = keyof typeof SECTIONS;
export type BundleBoard = { name: string; source: any; architecture: any } & Record<Section, any>;
export class BundleError extends Error {}
const fail = (message: string): never => { throw new BundleError(`bundle rule: ${message}`); };

const U64_MAX = 18446744073709551615n;
const encode = (codec: Codec, v: any): unknown => {
  switch (codec) {
    case 'u64': return v.toString();
    case 'time': return v.microsSinceUnixEpoch.toString();
    case 'identity': return v.toHexString();
    case 'u64[]': return v.map((x: bigint) => x.toString());
    case 'string[]': return [...v];
    case 'u64?': return v === undefined ? null : v.toString();
    default: return v;
  }
};

type Convert = { time: (micros: bigint) => unknown; identity: (hex: string) => unknown };
const PLAIN: Convert = { time: m => m, identity: h => h };

function decode(codec: Codec, v: unknown, at: string, conv: Convert): unknown {
  const u64 = (x: unknown) => typeof x === 'string' && /^(0|[1-9]\d{0,19})$/.test(x) && BigInt(x) <= U64_MAX ? BigInt(x) : fail(`${at} must be a decimal u64 string`);
  const int = (lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : fail(`${at} must be an integer from ${lo} to ${hi}`);
  switch (codec) {
    case 'u64': return u64(v);
    case 'u32': return int(0, 4294967295);
    case 'i32': return int(-2147483648, 2147483647);
    case 'f32': return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 3.4028234663852886e38 ? v : fail(`${at} must be a finite number`);
    case 'bool': return typeof v === 'boolean' ? v : fail(`${at} must be true or false`);
    case 'string': return typeof v === 'string' ? v : fail(`${at} must be a string`);
    case 'time': return typeof v === 'string' && /^-?(0|[1-9]\d{0,18})$/.test(v) ? conv.time(BigInt(v)) : fail(`${at} must be microseconds as a decimal string`);
    case 'identity': return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? conv.identity(v) : fail(`${at} must be 64 lowercase hex characters`);
    case 'u64[]': return Array.isArray(v) ? v.map((x, i) => u64(x)) : fail(`${at} must be an array`);
    case 'string[]': return Array.isArray(v) && v.every(x => typeof x === 'string') ? [...v] : fail(`${at} must be an array of strings`);
    case 'u64?': return v === null ? undefined : u64(v);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function decodeRow(cols: Cols, v: unknown, at: string, conv: Convert): any {
  if (!isObj(v)) fail(`${at} must be an object`);
  const keys = Object.keys(cols), got = Object.keys(v as object);
  if (got.length !== keys.length || got.some(k => !(k in cols))) fail(`${at} must have exactly the fields ${keys.join(', ')}`);
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = decode(cols[k], (v as any)[k], `${at}.${k}`, conv);
  return out;
}
const encodeRow = (cols: Cols, row: any) => Object.fromEntries(Object.keys(cols).map(k => [k, encode(cols[k], row[k])]));

/** The bundle file: the board as JSON, behind its format, version and the SHA-256 of that JSON. */
export function bundleText(board: BundleBoard): string {
  const body = JSON.stringify(board);
  return `{"format":"${BUNDLE_FORMAT}","version":${BUNDLE_VERSION},"sha256":"${sha256Hex(body)}","board":${body}}`;
}

/**
 * Decodes and checks a bundle file: size, format, version, checksum, every field's type, unique
 * ids and every relationship a restore remaps. Throws a BundleError sentence. The module passes
 * `conv` to get Timestamp and Identity values; without it they stay bigint micros and hex.
 */
export function parseBundle(text: string, conv: Convert = PLAIN): BundleBoard {
  if (new TextEncoder().encode(text).length > MAX_BUNDLE_BYTES) fail(`a bundle holds at most ${MAX_BUNDLE_BYTES / 1048576} MiB`);
  let file: unknown;
  try { file = JSON.parse(text); } catch { fail('the bundle is not valid JSON'); }
  if (!isObj(file) || file.format !== BUNDLE_FORMAT) fail('this file is not a board bundle');
  const f = file as Record<string, any>;
  if (!Number.isInteger(f.version) || f.version < 1) fail('the bundle has no valid format version');
  if (f.version > BUNDLE_VERSION) fail(`the bundle is format ${f.version}; this server reads formats up to ${BUNDLE_VERSION}`);
  if (Object.keys(f).join() !== 'format,version,sha256,board' || !isObj(f.board)) fail('the bundle must have exactly format, version, sha256 and board');
  if (typeof f.sha256 !== 'string' || sha256Hex(JSON.stringify(f.board)) !== f.sha256) fail('the bundle checksum does not match its contents');
  const raw = f.board as Record<string, unknown>;
  const expected = ['name', 'source', 'architecture', ...Object.keys(SECTIONS)];
  if (Object.keys(raw).length !== expected.length || expected.some(k => !(k in raw))) fail(`board must have exactly the fields ${expected.join(', ')}`);
  const board: any = {
    name: decode('string', raw.name, 'board.name', conv),
    source: decodeRow(SOURCE, raw.source, 'board.source', conv),
    architecture: raw.architecture === null ? null : decodeRow(ARCHITECTURE, raw.architecture, 'board.architecture', conv),
  };
  for (const [key, s] of Object.entries(SECTIONS) as [Section, { one?: true; cols: Cols }][]) {
    const v = raw[key];
    if (s.one) board[key] = v === null ? null : decodeRow(s.cols, v, `board.${key}`, conv);
    else if (!Array.isArray(v)) fail(`board.${key} must be an array`);
    else board[key] = v.map((row, i) => decodeRow(s.cols, row, `board.${key}[${i}]`, conv));
  }
  checkRelations(board);
  return board;
}

function keys(rows: any[], key: string, section: string): Set<bigint> {
  const seen = new Set<bigint>();
  for (const r of rows) {
    if (seen.has(r[key])) fail(`${section} repeats ${key} ${r[key]}`);
    seen.add(r[key]);
  }
  return seen;
}

// The live board cascades these (removeNodeRows, removeEdgeRows, clearCodeRefs), so a dangling one is corruption.
// Marks, routes, route events, trace spans and change-note readers may name deleted rows; a restore zeroes those.
function checkRelations(b: any): void {
  const nodes = keys(b.nodes, 'id', 'nodes'), edges = keys(b.edges, 'id', 'edges'), sets = keys(b.hideSets, 'id', 'hideSets'), refs = keys(b.codeRefs, 'id', 'codeRefs');
  const target = (kind: string, id: bigint, at: string) => {
    if (!(kind === 'node' ? nodes : kind === 'edge' ? edges : undefined)?.has(id)) fail(`${at} points at ${kind} ${id}, which is not in the bundle`);
  };
  const charts = new Set(b.nodes.filter((n: any) => n.kind === 'chart').map((n: any) => n.id));
  for (const e of b.edges) { target('node', e.fromNode, `edge ${e.id}`); target('node', e.toNode, `edge ${e.id}`); }
  for (const [section, key, within] of [['edgeWeights', 'edgeId', edges], ['edgeEvidenceHashes', 'edgeId', edges], ['charts', 'nodeId', charts], ['nodeIcons', 'nodeId', nodes], ['codeRefHashes', 'refId', refs]] as const) {
    for (const id of keys(b[section], key, section)) if (!within.has(id)) fail(`${section} names ${key} ${id}, which is not in the bundle${section === 'charts' ? ' as a chart node' : ''}`);
  }
  for (const m of b.hideSetMembers) { if (!sets.has(m.setId)) fail(`a hide set member names set ${m.setId}, which is not in the bundle`); target(m.targetKind, m.targetId, `hide set ${m.setId}`); }
  for (const r of b.codeRefs) target(r.targetKind, r.targetId, `code ref ${r.id}`);
  for (const n of b.changeNotes) { target('node', n.anchorId, 'a change note'); if (!refs.has(n.refId)) fail(`a change note names code ref ${n.refId}, which is not in the bundle`); }
  for (const t of b.threats) target('node', t.anchorId, 'a threat');
}

const rowKey = (r: any): bigint => r.id ?? r.nodeId ?? r.edgeId ?? r.refId;
const byKey = (a: any, b: any) => (rowKey(a) < rowKey(b) ? -1 : rowKey(a) > rowKey(b) ? 1 : 0);

/** Reads one board's persistent content. Call it inside one transaction, so the bundle is one consistent state. */
export function captureBoard(ctx: any, boardId: bigint, source: { workspaceId: bigint; architecture: any }): BundleBoard {
  const db = ctx.db;
  const board: any = {
    name: db.board.id.find(boardId).name,
    source: encodeRow(SOURCE, { boardId, workspaceId: source.workspaceId, capturedAt: ctx.timestamp, capturedBy: ctx.sender }),
    architecture: source.architecture ? encodeRow(ARCHITECTURE, source.architecture) : null,
  };
  const sets = [...db.hideSet.boardId.filter(boardId)];
  for (const [key, s] of Object.entries(SECTIONS) as [Section, { table: string; one?: true; cols: Cols }][]) {
    if (s.one) {
      const row = db[s.table].boardId.find(boardId);
      board[key] = row ? encodeRow(s.cols, row) : null;
      continue;
    }
    let rows = key === 'hideSetMembers' ? sets.flatMap(set => [...db.hideSetMember.setId.filter(set.id)]) : [...db[s.table].boardId.filter(boardId)];
    // A claim is an agent's live lease, not content: the restored mark waits to be claimed again.
    if (key === 'marks') rows = rows.map(m => (m.status === 'claimed' ? { ...m, status: 'sent' } : m));
    board[key] = rows.sort(byKey).map(r => encodeRow(s.cols, r));
  }
  return board;
}

/**
 * Writes a parsed bundle (parseBundle with the module's `conv`) into the empty board `boardId`,
 * remapping every id. An id kept only as history (a mark's node, a route waypoint, a trace span's
 * node, a removed change-note reader) that is not in the bundle becomes 0: it never points at
 * another board's row. Call it in the transaction that created the board.
 */
export function restoreBoard(ctx: any, b: BundleBoard, boardId: bigint, epoch: unknown): void {
  const db = ctx.db, nodes = new Map<bigint, bigint>(), edges = new Map<bigint, bigint>(), sets = new Map<bigint, bigint>(), refs = new Map<bigint, bigint>();
  const to = (map: Map<bigint, bigint>, id: bigint) => map.get(id) ?? 0n;
  const target = (kind: string, id: bigint) => to(kind === 'node' ? nodes : edges, id);
  for (const n of b.nodes) nodes.set(n.id, db.node.insert({ ...n, id: 0n, boardId }).id);
  for (const e of b.edges) edges.set(e.id, db.edge.insert({ ...e, id: 0n, boardId, fromNode: to(nodes, e.fromNode), toNode: to(nodes, e.toNode), evidenceSnippet: '' }).id);
  for (const w of b.edgeWeights) db.edgeWeight.insert({ ...w, edgeId: to(edges, w.edgeId), boardId });
  for (const h of b.edgeEvidenceHashes) db.edgeEvidenceHash.insert({ ...h, edgeId: to(edges, h.edgeId), boardId });
  for (const c of b.charts) db.chart.insert({ ...c, nodeId: to(nodes, c.nodeId), boardId });
  for (const i of b.nodeIcons) db.nodeIcon.insert({ ...i, nodeId: to(nodes, i.nodeId), boardId });
  for (const s of b.hideSets) sets.set(s.id, db.hideSet.insert({ ...s, id: 0n, boardId }).id);
  for (const m of b.hideSetMembers) db.hideSetMember.insert({ id: 0n, setId: to(sets, m.setId), targetKind: m.targetKind, targetId: target(m.targetKind, m.targetId) });
  for (const f of b.repoFiles) db.repoFile.insert({ id: 0n, boardId, path: f.path });
  for (const r of b.codeRefs) refs.set(r.id, db.codeRef.insert({ ...r, id: 0n, boardId, targetId: target(r.targetKind, r.targetId), snippet: '' }).id);
  for (const h of b.codeRefHashes) db.codeRefHash.insert({ ...h, refId: to(refs, h.refId), boardId });
  for (const n of b.changeNotes) {
    const readers = remapJson(n.readers, (r: any) => ({ ...r, refId: to(refs, BigInt(r.refId)).toString() }));
    db.changeNote.insert({ ...n, id: 0n, boardId, anchorId: to(nodes, n.anchorId), refId: to(refs, n.refId), readers });
  }
  for (const t of b.threats) db.threat.insert({ ...t, id: 0n, boardId, anchorId: to(nodes, t.anchorId) });
  for (const m of b.marks) db.mark.insert({ ...m, id: 0n, boardId, nodeId: to(nodes, m.nodeId), preferredAgent: '', claimedBy: '', leaseUntil: epoch, claimGen: 0 });
  for (const e of b.routeEvents) db.routeEvent.insert({ ...e, id: 0n, boardId, nodeId: e.nodeId === undefined ? undefined : to(nodes, e.nodeId), nodeIds: e.nodeIds.map((id: bigint) => to(nodes, id)) });
  if (b.session) db.session.insert({ ...b.session, id: 0n, boardId });
  if (b.sessionRoute) db.sessionRoute.insert({ ...b.sessionRoute, boardId, nodeIds: b.sessionRoute.nodeIds.map((id: bigint) => to(nodes, id)) });
  if (b.sessionRemote) db.sessionRemote.insert({ ...b.sessionRemote, boardId });
  if (b.tracePlayback) db.tracePlayback.insert({ ...b.tracePlayback, boardId, spans: remapJson(b.tracePlayback.spans, (s: any) => ({ ...s, node: to(nodes, BigInt(s.node)).toString() })) });
}

// readers and spans are JSON arrays of objects holding a decimal id; anything else is kept verbatim.
function remapJson(json: string, f: (item: any) => any): string {
  let items: unknown;
  try { items = JSON.parse(json); } catch { return json; }
  if (!Array.isArray(items)) return json;
  return JSON.stringify(items.map(item => {
    const id = isObj(item) ? (item.refId ?? item.node) : undefined;
    return typeof id === 'string' && /^\d{1,20}$/.test(id) ? f(item) : item;
  }));
}
