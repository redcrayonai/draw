/**
 * The hosted MCP tools (spec §4): the stdio server's tools minus
 * link_dashboard, each taking an explicit `board` (the id start_session
 * returned) instead of a process-wide active board. Tools that act on an
 * existing node, edge, ref or chart read it first, so a target that is not on
 * `board` gets the not-found text and nothing is written.
 *
 * Every call passes one gate, in order: the per-account rate limit, the plan
 * limit (the USER Durable Object counts the call), the agent's one-time link
 * and join, then the tool with a 15 s budget. Failures go through scrub().
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { CHART_MIN_H, CHART_MIN_W, CHART_TYPES, HUMAN_SOURCE_RESERVED, MAX_CSV_BYTES, SAMPLE_RESERVED } from '../../module/src/chart-contracts';
import { traceMs } from '../../module/src/trace';
import { MARK_FILES_MAX, MARK_FILE_MAX, MARK_REPLY_MAX, SEAT_RE } from '../../module/src/marks';
import { ICONS, ICON_SECTIONS } from '../../module/src/node-icons';
import { chartSummaryText, chartTypesText, checkChartInput, checkChartUpdate, describeChartsText, notAChart, optionsText } from '../../agent/src/charts';
import {
  ADD_NOTE_DESCRIPTION,
  CHECKPOINT_NOTES_TEXT,
  MAIN_REF_RULE_TEXT,
  REMOVE_NOTE_DESCRIPTION,
  SCHEMA_HINT,
  UPDATE_NOTE_DESCRIPTION,
  addNoteArgs,
  noteInput,
  noteUpdateInput,
  updateNoteArgs,
} from '../../agent/src/change-notes';
import {
  ADD_THREAT_DESCRIPTION,
  REMOVE_THREAT_DESCRIPTION,
  UPDATE_THREAT_DESCRIPTION,
  addThreatArgs,
  threatInput,
  threatUpdateInput,
  updateThreatArgs,
} from '../../agent/src/threats';
import { describeCommit, ownNewIds } from '../../agent/src/ids';
import { labelFitHint } from '../../agent/src/results';
import { arriveFlow, routeSnapshot } from '../../agent/src/routes';
import {
  SESSION_NAME_MAX,
  SESSION_NAME_RE,
  SESSION_NAME_RULE,
  addCodeRefFlow,
  addCodeRefText,
  boardStoresCode,
  flowBudget,
  markCheckpointFlow,
  prepareSourceEvidence,
  startSessionFlow,
  writeCode,
  type SessionDeps,
} from '../../agent/src/session';
import { withBoard } from '../../agent/src/results';
import { CaptureRejection, type ClaimBoard, type ClaimedCapture } from '../../shared/capture';
import { captureDeps } from './capture-deps';
import { citedPaths, claim, type CaptureStub } from './captures';
import { DEFAULT_DASHBOARD_URL, dashboardLinkUrl, newLinkCode } from './dashboard-link';
import { guardSecrets } from '../../agent/src/session';
import { DbError, identityArg } from '../../shared/db-http';
import { identityFromClaims } from '../../shared/identity';
import { sha256, type Principal, type UserInfo } from './auth';
import { principalSubject, mintMarks, mintTap } from './issuer';
import { boardText, readBoard } from './board';
import { groupByFiles, newSeat } from './marks';
import type { LiveStub } from './live';
import {
  boardNotFound,
  captureNeeded,
  idTooLarge,
  linkNotFound,
  monthName,
  EARLIER_WRITE,
  noSession,
  partialWrite,
  planLimit,
  quotaSpent,
  rateLimited,
  sameCall,
  targetNotFound,
  newRef,
} from './copy';
import { safeToken, safeU64, sql, type Database, type SafeToken, type SafeU64 } from './db';
import type { Env, Origins } from './env';
import { version } from './env';
import { createSnapshot } from './snapshot';
import { DENYLIST } from './copy';
import { Refusal, errorKind, errorResult, isTransport, okResult, scrub, type Outcome, type ToolResult } from './scrub';
import { PLANS, monthOf } from './user';

export interface Ledger {
  charge(month: string, limit: number): Promise<{ ok: boolean; used: number }>;
  claim(key: string): Promise<{ first: true } | { first: false; text: string; ageS: number }>;
  settle(key: string, text: string | null): Promise<void>;
}

/** The billing gate: may `userId` spend `cost` (one per tool call)? It runs here, in the Worker, never in the database. */
export interface Quota {
  check(userId: string, cost: number): Promise<boolean>;
}

export type LogLine = {
  reqId: string;
  userId: string;
  clientId: string;
  via: Principal['via'];
  tool: string;
  board: string;
  outcome: Outcome;
  status: number;
  dbCalls: number;
  dbMs: number;
  totalMs: number;
  cold: boolean;
  version: string;
};

export type CallContext = {
  env: Env;
  o: Origins;
  principal: Principal;
  /** the database as this user's agent */
  db: Database;
  /** the database as service:mcp */
  service: Database;
  ledger: Ledger;
  quota: Quota;
  /** the CAPTURE store for an id (captures.ts) */
  captures: (id: string) => CaptureStub;
  user: () => Promise<UserInfo>;
  log: (line: LogLine, ref?: string, original?: string) => void;
  reqId: string;
  cold: boolean;
  tracing?: Pick<Tracing, 'enterSpan'>;
};

/** `deadline`: when the tool's 15 s budget ends (Date.now() ms). */
type T = { ctx: CallContext; signal: AbortSignal; named: (board: string) => void; deadline: number };

type ToolDef = {
  title: string;
  description: string;
  input: z.ZodObject;
  scope: 'board:read' | 'board:write';
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  run: (args: any, t: T) => Promise<ToolResult>;
};

export const TOOL_BUDGET_MS = 15_000;

// ---------- shared pieces ----------

const id = z.string().regex(/^\d+$/).describe('numeric id as a string');
const boardArg = z.string().regex(/^\d+$/).describe('the board id start_session returned');
const seatArg = z.string().regex(SEAT_RE).describe('the seat start_session returned');
const grid = z.number().int().describe('integer, must be divisible by 4');
const CAPTURE_DESCRIPTION =
  'Leave empty when the redcrayon plugin is installed; it fills this in. Otherwise run npx -y @redcrayonai/draw@1 capture … in the project and pass the id it prints.';
const capture = z.string().regex(/^cap_[A-Za-z0-9]{22}$/).optional().describe(CAPTURE_DESCRIPTION);

function u64(value: string): SafeU64 {
  const n = safeU64(value);
  if (n === undefined) throw new Refusal(idTooLarge(value));
  return n;
}

type Row = Record<string, any>;

/** Same writers as the module's assertBoardWrite, for an agent token: link-edit needs a person's account. */
async function assertWriter(t: T, b: { id: bigint; name: string }, what: string): Promise<void> {
  const mine = await t.ctx.db.read<Row>(sql`SELECT * FROM my_boards`, t.signal);
  if (!mine.some(r => r.boardId === b.id && ['owner', 'grant', 'team', 'agent'].includes(String(r.access)))) {
    throw new Refusal(`REJECTED: you cannot edit this board, so you cannot ${what} board=${b.name}`);
  }
}

async function boardOf(t: T, board: string): Promise<{ id: SafeU64; name: string }> {
  const boardId = u64(board);
  const [row] = await t.ctx.db.read<Row>(sql`SELECT * FROM visible_board WHERE id = ${boardId}`, t.signal);
  if (!row) throw new Refusal(boardNotFound(board));
  t.named(row.name);
  return { id: boardId, name: row.name };
}

/** The board and a target row on it, read together; a target elsewhere is "not found on board". */
async function boardAndTarget(t: T, board: string, kind: 'node' | 'edge' | 'code ref' | 'chart' | 'change note' | 'threat', target: string) {
  const targetId = u64(target);
  const query =
    kind === 'node'
      ? sql`SELECT * FROM visible_node WHERE id = ${targetId}`
      : kind === 'edge'
        ? sql`SELECT * FROM visible_edge WHERE id = ${targetId}`
        : kind === 'code ref'
          ? sql`SELECT * FROM visible_code_ref WHERE id = ${targetId}`
          : kind === 'change note'
            ? sql`SELECT * FROM visible_change_note WHERE id = ${targetId}`
            : kind === 'threat'
              ? sql`SELECT * FROM visible_threat WHERE id = ${targetId}`
              : sql`SELECT * FROM visible_chart WHERE node_id = ${targetId}`;
  const [b, rows] = await Promise.all([boardOf(t, board), t.ctx.db.read<Row>(query, t.signal)]);
  const row = rows[0];
  if (!row || row.boardId !== b.id) throw new Refusal(kind === 'chart' ? `REJECTED: ${notAChart(target)} board=${b.name}` : targetNotFound(kind, target, b.name));
  return { board: b, row, targetId };
}

/**
 * Every node id must be on `b`. The module would refuse one elsewhere too, but
 * its sentence names the other board's id: one text for unknown (spec §4).
 */
async function nodesOnBoard(t: T, b: { id: SafeU64; name: string }, ids: SafeU64[]) {
  if (ids.length === 0) return;
  const on = new Set((await t.ctx.db.read<Row>(sql`SELECT id FROM visible_node WHERE board_id = ${b.id}`, t.signal)).map(n => n.id as bigint));
  const missing = ids.find(id => !on.has(id));
  if (missing !== undefined) throw new Refusal(targetNotFound('node', missing, b.name));
}

const committed = (board: string, text = 'committed') => okResult(`${text} board=${board}`);

/** Known-not-committed answers that may be retried: the host's 5xx (not a module refusal) before the reducer ran. */
const retryable = (err: unknown) => err instanceof DbError && err.status >= 500 && err.status !== 530;

/** An absolute write (spec §3 Retry table): repeating it changes nothing, so a lost answer is tried once more. */
async function absolute(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (!retryable(err) && !isTransport(err)) throw err;
    await run();
  }
}

/** A delete or attach: on the retry, "does not exist" means the first one landed. */
async function removal(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (!retryable(err) && !isTransport(err)) throw err;
    try {
      await run();
    } catch (again) {
      if (again instanceof DbError && again.status === 530 && /does not exist|not found/.test(again.message)) return;
      throw again;
    }
  }
}

/**
 * A create: never written twice (spec §3 Retry table). Ids before, the call,
 * ids after; when the answer is lost, a matching new row means it committed.
 * The USER DO's window answers a client's own repeat with the first result.
 */
async function create(
  t: T,
  tool: string,
  key: Record<string, unknown>,
  before: () => Promise<Set<bigint>>,
  write: () => Promise<void>,
  after: (before: Set<bigint>) => Promise<bigint[]>
): Promise<{ text: string; repeat?: string }> {
  const call = t.ctx.principal?.machine ? [principalSubject(t.ctx.principal), tool, key] : [tool, key];
  const dedupe = await sha256(JSON.stringify(call, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const claim = await t.ctx.ledger.claim(dedupe);
  if (!claim.first) {
    await assertMachineBoardCall(t, key);
    return { text: claim.text, repeat: sameCall(claim.ageS) };
  }
  let text: string | null = null;
  try {
    const ids = await before();
    try {
      await write();
    } catch (err) {
      if (!retryable(err) && !isTransport(err)) throw err;
      const landed = await after(ids).catch(() => []);
      if (landed.length === 0) {
        if (!retryable(err)) throw err; // a lost answer with no row yet: UNCONFIRMED, never a second write
        await write();
      }
    }
    // The write committed: a failed read now only loses the id, never the outcome.
    text = describeCommit(await after(ids).catch(() => []));
    return { text };
  } finally {
    await t.ctx.ledger.settle(dedupe, text);
  }
}

/** Open DB connections a Worker keeps per request (spec §2 Workers facts); more requests queue, and each one's 5 s runs while it waits. */
const DB_CONNECTIONS = 6;

/**
 * Run `units` of writes in order, DB_CONNECTIONS writes at a time. A unit
 * starts only before `stopAt` (the first always starts) and, once started,
 * runs to the end. Nothing new starts after a write fails; the failure is
 * thrown once the writes in flight settle, so the call's write count is final.
 * Returns how many units ran.
 */
async function inLanes(units: (() => Promise<void>)[][], stopAt: number): Promise<number> {
  let next = 0;
  let failed = false;
  const queue: (() => Promise<void>)[] = [];
  const lane = async () => {
    while (!failed) {
      if (queue.length === 0) {
        if (next === units.length || (next > 0 && Date.now() >= stopAt)) return;
        queue.push(...units[next++]);
      }
      try {
        await queue.shift()!();
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const lanes = await Promise.allSettled(Array.from({ length: DB_CONNECTIONS }, lane));
  const rejected = lanes.find(l => l.status === 'rejected');
  if (rejected) throw (rejected as PromiseRejectedResult).reason;
  return next;
}

const hasRefs = async (t: T, nodeId: SafeU64) =>
  (await t.ctx.db.read<Row>(sql`SELECT * FROM visible_code_ref WHERE target_id = ${nodeId}`, t.signal)).some(r => r.targetKind === 'node');
const iconOn = async (t: T, nodeId: SafeU64) =>
  (await t.ctx.db.read<Row>(sql`SELECT * FROM visible_node_icon WHERE node_id = ${nodeId}`, t.signal)).length > 0;

// ---------- descriptions (ported from the retired stdio server, process-specific text removed) ----------

// The library icons by section, from the registry the module checks (spec 2026-10-18).
const ICON_LIST = ICON_SECTIONS.map(s => `${s.title.toLowerCase()}: ${ICONS.filter(i => i.section === s.id).map(i => i.id).join(', ')}`).join('; ');
const ICON_RULE =
  ` icon (optional): a library icon drawn above the label (beside a boundary's heading), one of ${ICON_LIST}. ` +
  'Give one when the node is that kind of thing (an agent, a model, a queue) or that product or cloud (claude, aws); leave it out otherwise. Not on notes, charts or architecture boards. A node with an icon needs about 40 px more height (160x96 shows icon, label and sublabel).';
const FIT_RULE =
  'The board draws exactly the stored box: the label wraps to at most 2 lines inside w (16 px padding each side; ellipse and pill rows are narrower) and is cut off after that; the sublabel takes one line below it; a node with code refs keeps a row for its badge. At 15 px a label and sublabel need h=48 on one line and 68 on two. ' +
  'When the box cuts something off, the result says so and names the size that shows it: "(label wraps to N lines; cut off below w=W — widen to W to show it in full)", "(sublabel cut off below w=W)", "(needs h=H to show label and sublabel)".';

const EDITORIAL_RULES = `Editorial rules (enforced where noted):
- x/y/w/h divisible by 4 (enforced; violations are rejected, never rounded)
- at most 2 focal nodes per board (enforced); accent color renders only on focal nodes
- token: ink (normal) | muted (infrastructure/secondary) | accent
- deletion is the strongest edit; target density ~4/10 with generous whitespace
- containers are large nodes drawn behind smaller ones: create big, move members inside
- layout reads left→right: entry points left, services middle, data stores right; 48px+ gutters
- After drawing, call layout_board; it places nodes left to right and fits boundaries.`;

const BOARD_SUFFIX = ' Returns texts ending in board=<name>, the board it acted on.';

const chartOptions = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .optional()
  .describe('JSON object of options for the type (see describe_charts); omit for the defaults');
const exclude = z.array(z.object({ reason: z.string(), glob: z.string() }).strict()).optional();

// ---------- the tools ----------

export const TOOLS: Record<string, ToolDef> = {
  get_board: {
    title: 'Get board',
    scope: 'board:read',
    annotations: { readOnlyHint: true },
    description:
      'Read the live board: all nodes and edges. Humans may be editing concurrently — re-read after your own edits or before relying on positions. ' +
      'On a session board the result includes session { checkpoint, headSha, coverage }, route { revision, waypoints, destinationId, arrived, complete, history } when planned, and, per node and edge, refs [{ id, symbol, path, startLine, endLine, checkpoint, status }] without snippets. Edges include evidenceStatus; stale source evidence needs a corrected citation. Edges with a latency carry latencyMs and latencySource. ' +
      'A chart node carries chart { type, source, rows, series, xRange?, warnings? } (never its CSV: get_chart reads that). ' +
      'A node with a library icon carries icon (its id, as create_node takes it). ' +
      'Flagged changes are under changeNotes [{ id, anchorId, kind, severity, title, refId, readers [{ refId, subject, status }], reviewed }]; a stale reader still reads the changed column. ' +
      'Flagged threats are under threats [{ id, anchorId, stage, severity, title, contained }]; only board members see them. ' +
      'A large board drops doc bodies, then hidden rows, then the highest ids, and says how many under omitted. ' +
      EDITORIAL_RULES,
    input: z.object({ board: boardArg }).strict(),
    async run({ board }, t) {
      const boardId = u64(board);
      const rows = await readBoard(t.ctx.db, boardId, t.signal);
      if (!rows.board) throw new Refusal(boardNotFound(board));
      t.named(rows.board.name);
      return okResult(boardText(rows, boardId));
    },
  },

  create_node: {
    title: 'Create node',
    scope: 'board:write',
    description:
      'Create a node on the board. All of x, y, w, h must be divisible by 4. token: ink|muted|accent. kind: service|datastore|external|boundary|note|text (drives the visual grammar; defaults to service; for a chart use create_chart). text is a free heading: label only, markdown **bold** *italic* ~~strike~~ `code`, newlines break lines, size s|m|l = 14|20|28 px; give it a box about 0.6 × font px per character wide and 1.3 × font px per line tall. doc: optional, at most two sentences on what this component is and why it exists. Setting focal=true is rejected if 2 focal nodes already exist. Returns "committed id=<n> board=<name>".' +
      ICON_RULE + ' ' +
      FIT_RULE,
    input: z
      .object({
        board: boardArg,
        label: z.string(),
        sublabel: z.string().describe('mono technical identifier, or empty string'),
        x: grid,
        y: grid,
        w: grid,
        h: grid,
        token: z.string(),
        focal: z.boolean(),
        kind: z.string().optional().describe('service|datastore|external|boundary|note|text (charts: use create_chart)'),
        doc: z.string().optional().describe('at most two sentences: what this is and why'),
        icon: z.string().optional().describe('library icon id, e.g. agent, model, queue, claude, aws'),
      })
      .strict(),
    async run({ board, icon, ...input }, t) {
      const boardId = u64(board);
      // The board check and the ids before are independent reads: one round trip, not two. Nothing is written until both pass.
      const found = boardOf(t, board);
      found.catch(() => {});
      const matches = (n: Row) => n.label === input.label && n.sublabel === input.sublabel && n.x === input.x && n.y === input.y;
      const nodes = () => t.ctx.db.read<Row>(sql`SELECT id, board_id, label, sublabel, x, y FROM visible_node WHERE board_id = ${boardId}`, t.signal);
      // With an icon, create_icon_node writes the node and its icon in one transaction.
      const { text, repeat = '' } = await create(
        t,
        'create_node',
        { board, ...input, icon },
        async () => new Set((await Promise.all([found, nodes()]))[1].map(n => n.id as bigint)),
        () => (icon === undefined ? t.ctx.db.call('create_node', { boardId, ...input }, t.signal) : t.ctx.db.call('create_icon_node', { boardId, ...input, icon }, t.signal)),
        async before => ownNewIds(before, (await nodes()) as never[], boardId, matches)
      );
      const b = await found;
      return okResult(`${text}${labelFitHint({ ...input, size: '', kind: input.kind ?? 'service', icon: icon !== undefined })} board=${b.name}${repeat}`);
    },
  },

  move_node: {
    title: 'Move node',
    scope: 'board:write',
    description: 'Move a node (top-left corner). x and y must be divisible by 4.' + BOARD_SUFFIX,
    input: z.object({ board: boardArg, nodeId: id, x: grid, y: grid }).strict(),
    async run({ board, nodeId, x, y }, t) {
      const { board: b, targetId } = await boardAndTarget(t, board, 'node', nodeId);
      await absolute(() => t.ctx.db.call('move_node', { nodeId: targetId, x, y }, t.signal));
      return committed(b.name);
    },
  },

  layout_board: {
    title: 'Lay out board',
    scope: 'board:write',
    description:
      'Lay out the board left to right: entry points left, data stores right, members kept inside their containers, room left for edge labels. Moves nodes and resizes containers (boundaries, and any non-chart node drawn around others) to fit their members; hidden nodes stay where they are; other node sizes do not change. Call it after a pass that added nodes or edges, before mark_checkpoint; skip it when a person has arranged the board. Returns "committed layout: moved <n>, resized <m> board=<name>".',
    input: z.object({ board: boardArg }).strict(),
    async run({ board }, t) {
      const b = await boardOf(t, board);
      const [nodes, edges] = await Promise.all([
        t.ctx.db.read<Row>(sql`SELECT * FROM visible_node WHERE board_id = ${b.id}`, t.signal),
        t.ctx.db.read<Row>(sql`SELECT * FROM visible_edge WHERE board_id = ${b.id}`, t.signal),
      ]);
      // import() defers evaluating the layout engine; Wrangler ships one script, so it is still parsed at startup.
      const { planLayout, layoutUnits } = await import('./layout-apply');
      const laid = nodes.map(n => ({ id: n.id, kind: n.kind, x: n.x, y: n.y, w: n.w, h: n.h, hidden: n.hidden }));
      const plan = await planLayout(
        laid,
        edges.map(e => ({ id: e.id, from: e.fromNode, to: e.toNode, label: e.label, hidden: e.hidden }))
      );
      if (plan.moves.length === 0 && plan.resizes.length === 0) return committed(b.name, 'committed layout: already laid out');
      // Whole units only (layout-apply.ts): re-planning after a stop is idempotent only across complete units.
      const units = layoutUnits(laid, plan);
      const writes = units.map(u => [
        ...u.moves.map(m => () => absolute(() => t.ctx.db.call('move_node', { nodeId: m.id, x: m.x, y: m.y }, t.signal))),
        ...u.resizes.map(r => () => absolute(() => t.ctx.db.call('resize_node', { nodeId: r.id, x: r.x, y: r.y, w: r.w, h: r.h }, t.signal))),
      ]);
      // A write started at the cut-off still has its 5 s, and 1 s to answer, inside the tool's 15 s.
      const done = units.slice(0, await inLanes(writes, t.deadline - 6_000));
      const A = plan.moves.length;
      const B = plan.resizes.length;
      if (done.length === units.length) return committed(b.name, `committed layout: moved ${A}, resized ${B}`);
      const moved = done.reduce((n, u) => n + u.moves.length, 0);
      const resized = done.reduce((n, u) => n + u.resizes.length, 0);
      return committed(b.name, `committed layout: moved ${moved} of ${A}, resized ${resized} of ${B}; call again to continue`);
    },
  },

  update_node: {
    title: 'Update node',
    scope: 'board:write',
    description:
      'Update any of label, sublabel, token, focal, kind, icon on a node. Omitted fields keep their current value; icon "" removes the icon. A chart cannot change kind and no node can become a chart; chart data changes with set_chart_data.' +
      ICON_RULE + ' ' + FIT_RULE,
    input: z
      .object({
        board: boardArg,
        nodeId: id,
        label: z.string().optional(),
        sublabel: z.string().optional(),
        token: z.string().optional(),
        focal: z.boolean().optional(),
        kind: z.string().optional().describe('service|datastore|external|boundary|note|text (charts: use create_chart)'),
        icon: z.string().optional().describe('library icon id, or "" to remove the icon'),
      })
      .strict(),
    async run({ board, nodeId, icon, ...patch }, t) {
      const { board: b, row, targetId } = await boardAndTarget(t, board, 'node', nodeId);
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      // A kind change lands before the icon, so an icon may go onto a node that just became a service.
      if (Object.keys(defined).length > 0 || icon === undefined) {
        await absolute(() => t.ctx.db.call('update_node', { nodeId: targetId, ...patch }, t.signal));
      }
      if (icon !== undefined) await absolute(() => t.ctx.db.call('set_node_icon', { nodeId: targetId, icon }, t.signal));
      const [refs, hasIcon] = await Promise.all([hasRefs(t, targetId).catch(() => false), icon !== undefined ? icon !== '' : iconOn(t, targetId).catch(() => false)]);
      return committed(b.name, 'committed' + labelFitHint({ ...(row as Row as { label: string; sublabel: string; w: number; h: number }), ...defined, hasRefs: refs, icon: hasIcon }));
    },
  },

  resize_node: {
    title: 'Resize node',
    scope: 'board:write',
    description:
      `Resize (and optionally reposition) a node. All of x, y, w, h must be divisible by 4; minimum size 64x48 (charts ${CHART_MIN_W}x${CHART_MIN_H}, free text 16x16). ` + FIT_RULE,
    input: z.object({ board: boardArg, nodeId: id, x: grid, y: grid, w: grid, h: grid }).strict(),
    async run({ board, nodeId, x, y, w, h }, t) {
      const { board: b, row, targetId } = await boardAndTarget(t, board, 'node', nodeId);
      await absolute(() => t.ctx.db.call('resize_node', { nodeId: targetId, x, y, w, h }, t.signal));
      const [refs, icon] = await Promise.all([hasRefs(t, targetId).catch(() => false), iconOn(t, targetId).catch(() => false)]);
      return committed(b.name, 'committed' + labelFitHint({ ...(row as Row as { label: string; sublabel: string }), w, h, hasRefs: refs, icon }));
    },
  },

  delete_node: {
    title: 'Delete node',
    scope: 'board:write',
    annotations: { destructiveHint: true },
    description: 'Delete a node; its edges are removed with it. Deletion is the strongest edit.' + BOARD_SUFFIX,
    input: z.object({ board: boardArg, nodeId: id }).strict(),
    async run({ board, nodeId }, t) {
      const { board: b, targetId } = await boardAndTarget(t, board, 'node', nodeId);
      await removal(() => t.ctx.db.call('delete_node', { nodeId: targetId }, t.signal));
      return committed(b.name);
    },
  },

  create_edge: {
    title: 'Create edge',
    scope: 'board:write',
    description:
      'Create a directed edge between two nodes. evidence is REQUIRED and validated: ' +
      '"import" | "test-import" | "source:<path>:<line>" | "agent:<basis>". ' +
      'For source: the path is repo-relative as git prints it, and <line> must be a unique nonblank line you read; the server captures its exact text from a capture of the file and registers the path on first use. On session boards, each checkpoint follows that text only while it occurs exactly once; edited, missing or duplicate text makes the evidence stale. ' +
      '"agent:<basis>" is only for a flow no code shows, such as a scenario the user describes: <basis> says what it rests on (e.g. "agent:user described the topology"), and the board draws it as an unverified agent claim. When code shows the flow, cite source. "human:" is refused: a person drawing on the canvas gets it. Returns "committed id=<n> board=<name>".',
    input: z.object({ board: boardArg, fromNode: id, toNode: id, label: z.string(), evidence: z.string(), capture }).strict(),
    async run({ board, fromNode, toNode, label, evidence: given, capture: cap }, t) {
      let b: { id: SafeU64; name: string } = await boardOf(t, board);
      let evidence: string = given;
      let evidenceSnippet: string | undefined;
      let evidenceHash: string | undefined;
      let storeCode = false;
      if (given.startsWith('source:')) {
        // Source evidence is read from the user's file, never typed: the cited line comes from a capture.
        const s = await sessionBoard(t, board);
        const path = given.slice('source:'.length).replace(/:\d+$/, '');
        if (cap === undefined) throw new Refusal(captureNeeded('create_edge', `cite ${path} --board ${s.id}`));
        const captured = await claim(t.ctx.captures, cap, { tool: 'create_edge', path, board: claimBoard(s) });
        const deps = await flowDeps(t, s.id, captured);
        // Before the citation: its path registration is a write, and the next read of the snapshot costs all its views.
        storeCode = await boardStoresCode(deps.call, s.id);
        const src = await inFlow(s.name, () => prepareSourceEvidence({ ...deps, budget: flowBudget(Date.now) }, s.id, s.repoRoot, given));
        evidence = src.evidence;
        evidenceSnippet = src.evidenceSnippet;
        evidenceHash = src.evidenceHash;
        b = s;
      }
      const from = u64(fromNode);
      const to = u64(toNode);
      await nodesOnBoard(t, b, [from, to]);
      const edges = () => t.ctx.db.read<Row>(sql`SELECT id, board_id, from_node, to_node, label, evidence FROM visible_edge WHERE board_id = ${b.id}`, t.signal);
      const matches = (e: Row) => e.fromNode === from && e.toNode === to && e.label === label && e.evidence === evidence;
      // RC-690: the cited line only where the board keeps code; elsewhere ok without it, and its hash after.
      let kept = false;
      let landed: bigint[] = [];
      const { text, repeat = '' } = await create(
        t,
        'create_edge',
        { board, fromNode, toNode, label, evidence },
        async () => new Set((await edges()).map(e => e.id as bigint)),
        async () => {
          kept = await writeCode(storeCode, withText =>
            t.ctx.db.call(
              'create_edge',
              { boardId: b.id, fromNode: from, toNode: to, label, evidence, ...(evidenceHash === undefined || withText ? { evidenceSnippet } : { evidenceSnippet: '', evidenceStatus: 'ok' }) },
              t.signal
            )
          );
        },
        async before => (landed = ownNewIds(before, (await edges()) as never[], b.id, matches))
      );
      if (evidenceHash !== undefined) {
        for (const edgeId of landed) {
          await absolute(async () => {
            await writeCode(kept, withText => t.ctx.db.call('set_edge_evidence_code', { edgeId, lineHash: evidenceHash, snippet: withText ? evidenceSnippet : undefined }, t.signal));
          });
        }
      }
      const stored = evidence !== given ? ` (evidence stored as ${evidence})` : '';
      return okResult(`${text}${stored} board=${b.name}${repeat}`);
    },
  },

  hide_node: {
    title: 'Hide node',
    scope: 'board:write',
    description:
      'Hide a node (and implicitly its edges) from the rendered board without deleting it. ' +
      'Always pass set: a short reason label ("vendor libs", "schedulers") — the chrome shows one toggleable chip per set. ' +
      'Use this instead of delete for imported rows.' +
      BOARD_SUFFIX,
    input: z.object({ board: boardArg, nodeId: id, hidden: z.boolean(), set: z.string().optional() }).strict(),
    async run({ board, nodeId, hidden, set }, t) {
      const { board: b, targetId } = await boardAndTarget(t, board, 'node', nodeId);
      await absolute(() => t.ctx.db.call('set_node_hidden', { nodeId: targetId, hidden, setName: set }, t.signal));
      return committed(b.name);
    },
  },

  hide_edge: {
    title: 'Hide edge',
    scope: 'board:write',
    description:
      'Hide or unhide an edge without deleting it. Pass set: a short reason label. Hiding an edge whose endpoints are both visible is an explicit editorial act.' + BOARD_SUFFIX,
    input: z.object({ board: boardArg, edgeId: id, hidden: z.boolean(), set: z.string().optional() }).strict(),
    async run({ board, edgeId, hidden, set }, t) {
      const { board: b, targetId } = await boardAndTarget(t, board, 'edge', edgeId);
      await absolute(() => t.ctx.db.call('set_edge_hidden', { edgeId: targetId, hidden, setName: set }, t.signal));
      return committed(b.name);
    },
  },

  play_trace: {
    title: 'Play trace',
    scope: 'board:write',
    description: "Replay one request on the board: every viewer sees dots run from each span's parent node to its own node, timed by the spans and slowed down to be watchable; error spans turn red. Map each span to a board node id first (service or operation to node). Spans carry only id, parent (a span id), node, startMs (from the trace start), durationMs and status; send no attributes, URLs or payloads. source: prod (a production trace from a monitoring tool), local (measured on this machine), estimate (built from reading the code). A new trace replaces the last one on this board. Returns \"committed trace: <n> spans, <total>ms board=<name>\"." + BOARD_SUFFIX,
    input: z.object({ board: boardArg, spans: z.array(z.object({ id: z.string().min(1).max(64), parent: z.string().optional(), node: id, startMs: z.number().min(0), durationMs: z.number().min(0), status: z.enum(['ok', 'error']).optional() }).strict()).min(1).max(200), source: z.enum(['prod', 'local', 'estimate']), title: z.string().max(120).optional() }).strict(),
    async run({ board, spans, source, title }, t) {
      const b = await boardOf(t, board);
      await absolute(() => t.ctx.db.call('play_trace', { boardId: b.id, spans: JSON.stringify(spans), source, title: title ?? '' }, t.signal));
      return okResult(`committed trace: ${spans.length} spans, ${traceMs(spans)}ms board=${b.name}`);
    },
  },

  start_tap: {
    title: 'Start live tap',
    scope: 'board:write',
    description: "Let the user watch live traffic on this board while they run their app locally. Returns a token and the command to run: npx -y @redcrayonai/draw@1 tap --token <token>, in the background, from the project root. Before running it, write .redcrayon/tap.json as { \"board\": \"<id>\", \"services\": { \"<service.name>\": \"<node id>\" } }, mapping each OpenTelemetry service to the node that draws it. Then tell the user to point their app's OTLP exporter at http://127.0.0.1:4318 (HTTP, not gRPC) and press Live on the board. The tap keeps raw telemetry on their machine and sends only per-edge rates, latencies and error counts while someone watches. The token lasts 12 hours." + BOARD_SUFFIX,
    input: z.object({ board: boardArg }).strict(),
    async run({ board }, t) {
      if (t.ctx.principal.machine) throw new Refusal('REJECTED: service accounts cannot start a live tap. Nothing was written.');
      const b = await boardOf(t, board);
      await assertWriter(t, b, 'start a live tap on it');
      const token = await mintTap(t.ctx.env, principalSubject(t.ctx.principal), b.id);
      return okResult(JSON.stringify({ board: String(b.id), token, command: `npx -y @redcrayonai/draw@1 tap --token ${token}`, otlp: 'http://127.0.0.1:4318', expires_in_hours: 12 }, null, 1));
    },
  },

  tap_status: {
    title: 'Live tap status',
    scope: 'board:read',
    annotations: { readOnlyHint: true },
    description:
      'Check the live tap on this board: whether one is connected and since when, when it last sent numbers, and whether anyone has Live on. Call it after the user runs the start_tap command, to confirm it connected. ' +
      'Returns JSON { board, tap: "connected" | "none", connected_since, last_sent, watching, started_by_you }; times are ISO 8601 or null. A tap sends nothing while nobody watches, so last_sent stays null until someone turns Live on.' +
      BOARD_SUFFIX,
    input: z.object({ board: boardArg }).strict(),
    async run({ board }, t) {
      const b = await boardOf(t, board);
      const { LIVE } = t.ctx.env;
      // No live channel bound (tests): no tap can be connected.
      const s = LIVE ? await (LIVE.get(LIVE.idFromName(String(b.id))) as unknown as LiveStub).status() : null;
      const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());
      return okResult(
        JSON.stringify(
          {
            board: String(b.id),
            tap: s?.tap ? 'connected' : 'none',
            connected_since: iso(s?.since),
            last_sent: iso(s?.lastPublish),
            watching: s?.watching ?? false,
            started_by_you: s?.sub ? s.sub === principalSubject(t.ctx.principal) : null,
          },
          null,
          1
        )
      );
    },
  },

  stop_tap: {
    title: 'Stop live tap',
    scope: 'board:write',
    annotations: { idempotentHint: true },
    description:
      "Stop the live tap on this board when the user is done watching: the board's tap disconnects and its command exits, and every tap token issued for this board so far stops working, including ones not run yet. Call start_tap for a new one. " +
      'Returns JSON { board, stopped }: stopped is true when a tap was connected.' +
      BOARD_SUFFIX,
    input: z.object({ board: boardArg }).strict(),
    async run({ board }, t) {
      const b = await boardOf(t, board);
      await assertWriter(t, b, 'stop its live tap');
      const { LIVE } = t.ctx.env;
      // No live channel bound (tests): no tap can be connected, and no token can connect.
      const stopped = LIVE ? await (LIVE.get(LIVE.idFromName(String(b.id))) as unknown as LiveStub).stop() : false;
      return okResult(JSON.stringify({ board: String(b.id), stopped }, null, 1));
    },
  },

  set_edge_latency: {
    title: 'Set edge latency',
    scope: 'board:write',
    description: 'Set the hop latency of an edge in milliseconds and where the number came from: prod (production traces from a monitoring tool), local (measured on this machine: browser timings, curl, tests), estimate (read from the code). Never pass an estimate as prod or local; the board draws estimates differently. latencyMs -1 clears it.' + BOARD_SUFFIX,
    input: z.object({ board: boardArg, edgeId: id, latencyMs: z.number(), source: z.enum(['prod', 'local', 'estimate']).optional() }).strict(),
    async run({ board, edgeId, latencyMs, source }, t) {
      const { board: b, targetId } = await boardAndTarget(t, board, 'edge', edgeId);
      await absolute(() => t.ctx.db.call('set_edge_latency', { edgeId: targetId, latencyMs, source: source ?? '' }, t.signal));
      return committed(b.name);
    },
  },

  delete_edge: {
    title: 'Delete edge',
    scope: 'board:write',
    annotations: { destructiveHint: true },
    description: 'Delete an edge by id.' + BOARD_SUFFIX,
    input: z.object({ board: boardArg, edgeId: id }).strict(),
    async run({ board, edgeId }, t) {
      const { board: b, targetId } = await boardAndTarget(t, board, 'edge', edgeId);
      await removal(() => t.ctx.db.call('delete_edge', { edgeId: targetId }, t.signal));
      return committed(b.name);
    },
  },

  describe_charts: {
    title: 'Describe charts',
    scope: 'board:read',
    annotations: { readOnlyHint: true },
    description:
      `List the chart types and what each needs: purpose, columns, options with their defaults, row and series limits, what the reader sees, and a valid example CSV. Pass type for one; omit it for all ${CHART_TYPES.length}. ` +
      'Call it before create_chart. It reads no board. ' +
      chartTypesText(),
    input: z.object({ type: z.string().optional().describe(CHART_TYPES.join('|')) }).strict(),
    async run({ type }) {
      const d = describeChartsText(type);
      if (!d.ok) throw new Refusal(`REJECTED: ${d.error}`);
      return okResult(d.text);
    },
  },

  create_chart: {
    title: 'Create chart',
    scope: 'board:write',
    description:
      'Create a chart on the board from numbers you measured, such as perf before and after a change. Never invent numbers. Call describe_charts first for the columns, options and an example of each type. ' +
      `type: ${CHART_TYPES.join('|')}. ` +
      `x, y, w, h must be divisible by 4; a chart is at least ${CHART_MIN_W}x${CHART_MIN_H}. title is drawn as the label, subtitle as one line under it (or empty string). ` +
      `csv: the first row names the columns; at most ${MAX_CSV_BYTES} bytes. options: a JSON object, or omit it for the defaults. ` +
      "source is REQUIRED: the command and commit that produced the numbers, e.g. 'agent: npm run bench @ 1a2b3c4'. " +
      `${SAMPLE_RESERVED}. ${HUMAN_SOURCE_RESERVED}. ` +
      'The CSV and source are checked before anything is written: a problem answers "REJECTED: <sentence> board=<name>". ' +
      'Returns "committed id=<n> (<rows> rows; series: <names>; x: <first> → <last>; <warnings>) board=<name>". Read the warnings: they say what was folded or cut.',
    input: z
      .object({
        board: boardArg,
        title: z.string().describe('what the chart shows, drawn as the node label'),
        subtitle: z.string().describe('one line under the title (scope or unit), or empty string'),
        x: grid,
        y: grid,
        w: grid,
        h: grid,
        type: z.string().describe(CHART_TYPES.join('|')),
        csv: z.string().describe('header row, then one row per data point'),
        options: chartOptions,
        source: z.string().optional().describe("REQUIRED: the command and commit that produced the data, e.g. 'agent: npm run bench @ 1a2b3c4'"),
      })
      .strict(),
    async run({ board, title, subtitle, x, y, w, h, type, csv, source, options: rawOptions }, t) {
      const b = await boardOf(t, board);
      const options = optionsText(rawOptions);
      const check = checkChartInput({ type, csv, options, source });
      if (!check.ok) throw new Refusal(`REJECTED: ${check.error} board=${b.name}`);
      const nodes = () => t.ctx.db.read<Row>(sql`SELECT id, board_id, label, sublabel, x, y, kind FROM visible_node WHERE board_id = ${b.id}`, t.signal);
      const matches = (n: Row) => n.kind === 'chart' && n.label === title && n.sublabel === subtitle && n.x === x && n.y === y;
      const { text, repeat = '' } = await create(
        t,
        'create_chart',
        { board, title, subtitle, x, y, w, h, type, csv, options, source },
        async () => new Set((await nodes()).map(n => n.id as bigint)),
        () => t.ctx.db.call('create_chart', { boardId: b.id, label: title, sublabel: subtitle, x, y, w, h, type, csv, options, source }, t.signal),
        async before => ownNewIds(before, (await nodes()) as never[], b.id, matches)
      );
      return okResult(`${text}${chartSummaryText(check.summary)} board=${b.name}${repeat}`);
    },
  },

  set_chart_data: {
    title: 'Set chart data',
    scope: 'board:write',
    description:
      "Change a chart's type, csv, options or source. Omitted fields keep their stored value; the merged result is checked like create_chart. " +
      "When the numbers change, pass source to say where the new data came from: an omitted source is refused on sample data or a person's data, and otherwise keeps the stored one. " +
      `An options-only change keeps the source. ${HUMAN_SOURCE_RESERVED}. ` +
      'Returns "committed (<rows> rows; series: <names>; …) board=<name>".',
    input: z
      .object({
        board: boardArg,
        nodeId: id,
        type: z.string().optional().describe(CHART_TYPES.join('|')),
        csv: z.string().optional(),
        options: chartOptions,
        source: z.string().optional().describe("the command and commit that produced the data, e.g. 'agent: npm run bench @ 1a2b3c4'"),
      })
      .strict(),
    async run({ board, nodeId, type, csv, source, options: rawOptions }, t) {
      const { board: b, row, targetId } = await boardAndTarget(t, board, 'chart', nodeId);
      const options = optionsText(rawOptions);
      const check = checkChartUpdate(row as never, { type, csv, options, source });
      if (!check.ok) throw new Refusal(`REJECTED: ${check.error} board=${b.name}`);
      await absolute(() => t.ctx.db.call('set_chart_data', { nodeId: targetId, type, csv, options, source }, t.signal));
      return committed(b.name, 'committed' + chartSummaryText(check.summary));
    },
  },

  get_chart: {
    title: 'Get chart',
    scope: 'board:read',
    annotations: { readOnlyHint: true },
    description: "Read one chart's stored data: JSON { board, nodeId, type, options, source, csv }. get_board shows only a summary.",
    input: z.object({ board: boardArg, nodeId: id }).strict(),
    async run({ board, nodeId }, t) {
      const { board: b, row } = await boardAndTarget(t, board, 'chart', nodeId);
      return okResult(JSON.stringify({ board: b.name, nodeId, type: row.type, options: row.options, source: row.source, csv: row.csv }, null, 1));
    },
  },

  start_session: {
    title: 'Start session',
    scope: 'board:write',
    description:
      "Open this task's board and return its id; pass that id as board on every other tool. " +
      'Pass name (use the git branch unless told otherwise) to open your own board of that name, created on first call; or link (a board link the user gave you) to draw on that board. ' +
      'Returns JSON { board, id, url, seat, session, checkpoint?, repoRoot?, baseSha?, note?, dashboard?, dashboardNote? }: relay url to the user once, verbatim, before any other tool call, and relay dashboard with dashboardNote whenever they are there. ' +
      'session is true when code refs and checkpoints work on the board (a capture of your checkout is needed for that); note says why when they do not. ' +
      'seat is your name for wait_for_marks and reply_to_mark.',
    input: z
      .object({
        name: z
          .string()
          .min(1, SESSION_NAME_RULE)
          .max(SESSION_NAME_MAX, SESSION_NAME_RULE)
          .regex(SESSION_NAME_RE, SESSION_NAME_RULE)
          .optional()
          .describe(`board name: one short line (at most ${SESSION_NAME_MAX} characters), e.g. the git branch`),
        link: z.string().optional().describe("a board link, e.g. the url a previous start_session returned"),
        capture,
      })
      .strict(),
    async run({ name, link, capture: cap }, t) {
      if ((name === undefined) === (link === undefined)) throw new Refusal('REJECTED: start_session takes a name or a link, not both. Nothing was written. Call start_session with one of them.');
      const { db, o } = t.ctx;
      const start = cap === undefined ? undefined : await claim(t.ctx.captures, cap, { tool: 'start_session' });
      let boardId: SafeU64;
      let boardName: string;
      let session: Record<string, unknown> = { session: false, note: NO_CAPTURE_NOTE };
      if (link !== undefined) {
        const found = boardInLink(o, link, t.ctx.env.DB_NAME);
        let row: Row | undefined;
        if (typeof found === 'object') row = await boardOfShare(t, found.share);
        else if (found !== undefined) {
          const byLink = async () =>
            db.read<Row>(typeof found === 'bigint' ? sql`SELECT * FROM visible_board WHERE id = ${found}` : sql`SELECT * FROM visible_board WHERE slug = '${found}'`, t.signal);
          [row] = await byLink();
          // The person's own board, opened by its link: grant it to their agent as the dashboard would.
          if (!row && (await grantOwnBoard(t, String(found)))) [row] = await byLink();
        }
        if (!row) throw new Refusal(linkNotFound(link));
        boardId = row.id;
        boardName = row.name;
        if (start) {
          // A link opens a session only on the account's own session board from this checkout.
          const [mine, rows] = await Promise.all([
            db.read<Row>(sql`SELECT * FROM my_boards`, t.signal),
            db.read<Row>(sql`SELECT * FROM visible_session WHERE board_id = ${boardId}`, t.signal),
          ]);
          const own = mine.some(b => b.boardId === boardId && (b.access === 'owner' || b.access === 'grant'));
          const s = rows[0];
          session =
            own && s && s.repoRoot === start.toplevel
              ? { session: true, checkpoint: s.checkpoint, repoRoot: s.repoRoot, baseSha: s.baseSha }
              : { session: false, note: OTHER_CHECKOUT_NOTE };
        }
      } else if (start) {
        const chosen = await sessionName(t, name!, start.toplevel);
        // a re-adopted board by id: another checkout's board can share its name, and the snapshot holds one board's rows
        const snap = await snapshotFor(t, mine => chosen.boardId ?? mine.find(b => (b.access === 'owner' || b.access === 'grant') && b.name === chosen.name && b.isSession)?.boardId);
        const res = await inFlow(chosen.name, () =>
          startSessionFlow(
            { name: chosen.name, repoRoot: start.toplevel, force: false, activeBoardId: undefined, clientUrl: o.app, dbName: t.ctx.env.DB_NAME, myBoards: true },
            { ...captureDeps(start), call: snap.call }
          )
        );
        const [s] = await db.read<Row>(sql`SELECT * FROM visible_session WHERE board_id = ${res.boardId as SafeU64}`, t.signal);
        boardId = res.boardId as SafeU64;
        boardName = chosen.name;
        session = {
          session: true,
          checkpoint: res.checkpoint,
          repoRoot: res.repoRoot,
          baseSha: s?.baseSha,
          ...(chosen.suffixed ? { note: `a board named ${name} already tracks another checkout; this one is ${chosen.name}` } : {}),
        };
      } else {
        // One key per account and name: a retry, or the next session on this branch, finds the same board.
        const requestKey = safeToken(await sha256(`${t.ctx.principal.userId}|${name}`))!;
        await absolute(() => db.call('create_requested_board', { name: name!, orgId: '', requestKey }, t.signal));
        const [made] = await db.read<Row>(sql`SELECT * FROM my_board_creations WHERE request_key = '${requestKey}'`, t.signal);
        if (!made) throw new Refusal(boardNotFound(name!));
        const [row] = await db.read<Row>(sql`SELECT * FROM visible_board WHERE id = ${made.boardId as SafeU64}`, t.signal);
        boardId = made.boardId;
        boardName = row?.name ?? name!;
      }
      t.named(boardName);
      await showPresence(t, boardId);
      if (start && session.session === true) await recordRemote(t, boardId, start);
      const [board] = await db.read<Row>(sql`SELECT * FROM visible_board WHERE id = ${boardId}`, t.signal);
      return okResult(jsonText({ board: boardName, id: Number(boardId), url: o.boardUrl(String(board?.slug ?? '')), seat: newSeat(), ...session, ...(devCaller(t.ctx) ? await devLinkOffer(t) : {}) }));
    },
  },

  create_branch: {
    title: 'Create branch',
    scope: 'board:write',
    description:
      'Branch a board into a copy you can edit and submit for review: board = any board you own or were granted (or an imported snapshot; open its link with start_session first), name = the branch. ' +
      'The copy keeps every node, edge, icon, chart, hide set and code ref; the board itself does not change until the owner merges. You may submit the branch (submit_branch); only the owner accepts, rejects or merges, in the canvas. ' +
      'Calling it again with the same board and name returns the same branch. Returns JSON { board, id, url, base }: pass id as board on every later tool, and relay url to the user once.',
    input: z
      .object({
        board: boardArg,
        name: z.string().min(1, SESSION_NAME_RULE).max(SESSION_NAME_MAX, SESSION_NAME_RULE).regex(SESSION_NAME_RE, SESSION_NAME_RULE).describe('branch name: one short line'),
      })
      .strict(),
    async run({ board, name }, t) {
      const { db, o } = t.ctx;
      const base = await boardOf(t, board);
      // One key per account, snapshot and name: a retry finds the same branch.
      const requestKey = safeToken(await sha256(`${t.ctx.principal.userId}|branch|${base.id}|${name}`))!;
      await absolute(() => db.call('create_architecture_proposal', { baseBoardId: base.id, name, requestKey }, t.signal));
      const made = (await db.read<Row>(sql`SELECT * FROM visible_architecture_version WHERE request_key = '${requestKey}'`, t.signal)).find(v => v.baseBoardId === base.id);
      if (!made) throw new Refusal(boardNotFound(name));
      const [row] = await db.read<Row>(sql`SELECT * FROM visible_board WHERE id = ${made.boardId as SafeU64}`, t.signal);
      t.named(name);
      return okResult(jsonText({ board: name, id: Number(made.boardId), url: o.boardUrl(String(row?.slug ?? '')), base: Number(base.id) }));
    },
  },

  submit_branch: {
    title: 'Submit branch',
    scope: 'board:write',
    description:
      'Send a branch (a board create_branch returned) to its owner for review. Do this once the branch says what you intend; the owner accepts, rejects or merges it in the canvas, never you. ' +
      'A later graph edit returns it to draft; submit again after. Returns "committed board=<name>".' + BOARD_SUFFIX,
    input: z.object({ board: boardArg }).strict(),
    async run({ board }, t) {
      const b = await boardOf(t, board);
      await absolute(() => t.ctx.db.call('submit_architecture_proposal', { boardId: b.id }, t.signal));
      return committed(b.name);
    },
  },

  add_code_ref: {
    title: 'Add code ref',
    scope: 'board:write',
    description:
      'Attach a code ref (symbol + path + line range + snippet) to a node or edge on a session board. The server takes the snippet from a capture of your file; you never paste code. ' +
      'For .ts .tsx .mts .cts .js .jsx .mjs .cjs name the symbol and never pass startLine/endLine (a range is rejected): the server resolves the symbol to its lines now and re-finds it by name at every mark_checkpoint. ' +
      'Addressable: top-level function, class, interface, type, enum, namespace by bare name; class and interface members as Class.member; enum members as Enum.member, namespace members as NS.member, the default export as default and its members as default.member, CommonJS exports.x, module.exports and module.exports.member; ' +
      'a const resolves to its whole variable statement; overload signatures resolve together with their implementation; the range excludes leading JSDoc. Nested, local and object-literal declarations are not addressable: cite the enclosing declaration instead. ' +
      'For other file types startLine and endLine are required (1-based, inclusive). Snippets are capped at 60 lines / 4000 chars. The symbol (its last dotted segment) must occur in the captured lines. author: your subagent name, or omit. ' +
      'One ref per node or edge, path and symbol: adding it again answers "already attached id=<n> <path>:<start>-<end> board=<name>" and writes nothing. ' +
      'Result: "committed id=<n> <path>:<start>-<end> board=<name>".',
    input: z
      .object({
        board: boardArg,
        targetKind: z.enum(['node', 'edge']),
        targetId: id,
        path: z.string().describe('repo-relative path as git ls-files prints it'),
        symbol: z.string().min(1).regex(/[^.]$/, 'symbol must not end with a dot; name the member, e.g. Limiter.allow').describe('e.g. gitHead, Editor.handles, startSession'),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
        author: z.string().optional(),
        capture,
      })
      .strict(),
    async run({ board, targetKind, targetId, path, symbol, startLine, endLine, author, capture: cap }, t) {
      const b = await sessionBoard(t, board);
      if (cap === undefined) throw new Refusal(captureNeeded('add_code_ref', `ref ${path} --board ${b.id}`));
      // The target must be on this board: the module's own refusal names the other board's id.
      const target = u64(targetId);
      if (targetKind === 'node') await nodesOnBoard(t, b, [target]);
      else {
        const [edge] = await t.ctx.db.read<Row>(sql`SELECT board_id FROM visible_edge WHERE id = ${target}`, t.signal);
        if (!edge || edge.boardId !== b.id) throw new Refusal(targetNotFound('edge', targetId, b.name));
      }
      const captured = await claim(t.ctx.captures, cap, { tool: 'add_code_ref', path, board: claimBoard(b) });
      const deps = await flowDeps(t, b.id, captured);
      const res = await inFlow(b.name, () =>
        addCodeRefFlow({ boardId: b.id, repoRoot: b.repoRoot, targetKind, targetId: target, path, symbol, startLine, endLine, author }, deps)
      );
      return okResult(withBoard(addCodeRefText(res), b.name));
    },
  },

  mark_checkpoint: {
    title: 'Mark checkpoint',
    scope: 'board:write',
    description:
      'Record a checkpoint on a session board. Call it immediately before every git commit and before your final answer; it must be the last board write of the session. ' +
      'First re-anchors every code ref whose file changed since capture, and source evidence on edges; then computes coverage against the session baseSha: changed = diffed ∪ untracked files; a file is covered when an ok ref on this board intersects one of its diff hunks; ' +
      'exclude = [{ reason, glob }] groups uncovered paths you deliberately left off. ' +
      'Returns JSON { board, checkpoint, headSha, coverage: { changed, uncovered, excluded, deleted }, reanchor: { shifted, drifted, stale, ambiguous, restored }, citedPaths, notes? }. ' +
      'Act on it: draw or exclude what is uncovered; replace stale/ambiguous refs with remove_code_ref + add_code_ref under a corrected name; replace stale edge citations. restored lists refs and evidence that are ok again — no action needed.' +
      CHECKPOINT_NOTES_TEXT,
    input: z.object({ board: boardArg, exclude, capture }).strict(),
    async run({ board, exclude, capture: cap }, t) {
      const b = await sessionBoard(t, board);
      if (cap === undefined) throw new Refusal(captureNeeded('mark_checkpoint', `checkpoint --board ${b.id} --base ${b.baseSha}`));
      const captured = await claim(t.ctx.captures, cap, { tool: 'mark_checkpoint', board: claimBoard(b) });
      const deps = await flowDeps(t, b.id, captured, true);
      const res = await inFlow(b.name, () => markCheckpointFlow({ boardId: b.id, exclude }, deps));
      await recordRemote(t, b.id, captured);
      // The checkpoint is recorded: a failed read now only loses citedPaths (the hook keeps its list).
      return okResult(jsonText({ board: b.name, ...res, citedPaths: await boardCitedPaths(t, b.id).catch(() => undefined) }));
    },
  },

  plan_route: {
    title: 'Plan route',
    scope: 'board:write',
    description:
      'Plan the ordered waypoint nodes on a session board. All start pending; the final node is the destination. Route order is separate from evidence edges and never changes labels or styling. An identical plan is safe to retry; use reroute to change an existing plan. Node writes update focus but only arrive advances progress.',
    input: z.object({ board: boardArg, nodeIds: z.array(id).min(1) }).strict(),
    async run({ board, nodeIds }, t) {
      const b = await sessionBoard(t, board);
      const ids = nodeIds.map(u64);
      await nodesOnBoard(t, b, ids);
      return routeResult(t, b, () => t.ctx.db.call('plan_route', { boardId: b.id, nodeIds: ids }, t.signal));
    },
  },

  arrive: {
    title: 'Arrive',
    scope: 'board:write',
    description:
      'Arrive at the next pending waypoint. Re-anchor code refs and evidence and compute git coverage, then commit one checkpoint, route progress, history and your focus together. The previous waypoint becomes done and this waypoint becomes current. Retrying the current arrival returns its original checkpoint without a write. Older done arrivals and out-of-order arrivals reject.',
    input: z.object({ board: boardArg, nodeId: id, exclude, capture }).strict(),
    async run({ board, nodeId, exclude, capture: cap }, t) {
      const b = await sessionBoard(t, board);
      if (cap === undefined) throw new Refusal(captureNeeded('arrive', `checkpoint --board ${b.id} --base ${b.baseSha}`));
      const captured = await claim(t.ctx.captures, cap, { tool: 'arrive', board: claimBoard(b) });
      const deps = await flowDeps(t, b.id, captured, true);
      const res = await inFlow(b.name, () => arriveFlow({ boardId: b.id, nodeId: u64(nodeId), exclude }, deps));
      await recordRemote(t, b.id, captured);
      return okResult(jsonText({ board: b.name, ...res, citedPaths: await boardCitedPaths(t, b.id).catch(() => undefined) }));
    },
  },

  reroute: {
    title: 'Reroute',
    scope: 'board:write',
    description:
      'Change pending waypoints while preserving done/current stops. Give a nonempty reason for the history. First removes pending IDs named in remove or add, then inserts add entries in argument order. Each index is zero-based within the remaining pending list at that insertion. Absent removals have no effect; an unchanged reroute adds no history. The final resulting waypoint is the destination.',
    input: z
      .object({
        board: boardArg,
        add: z.array(z.object({ nodeId: id, index: z.number().int().min(0).max(0xffffffff) }).strict()).optional(),
        remove: z.array(id).optional(),
        reason: z.string().trim().min(1),
      })
      .strict(),
    async run({ board, add = [], remove = [], reason }, t) {
      const b = await sessionBoard(t, board);
      const addNodeIds = add.map((a: { nodeId: string }) => u64(a.nodeId));
      const removeNodeIds = remove.map(u64);
      await nodesOnBoard(t, b, addNodeIds);
      return routeResult(t, b, () =>
        t.ctx.db.call('reroute', { boardId: b.id, addNodeIds, addIndices: add.map((a: { index: number }) => a.index), removeNodeIds, reason }, t.signal)
      );
    },
  },

  remove_code_ref: {
    title: 'Remove code ref',
    scope: 'board:write',
    annotations: { destructiveHint: true },
    description:
      'Delete one code ref by id (ids come from get_board refs or the add_code_ref result). Use it to replace a stale or ambiguous ref without deleting its node: remove_code_ref, then add_code_ref with the corrected symbol.' +
      MAIN_REF_RULE_TEXT +
      BOARD_SUFFIX,
    input: z.object({ board: boardArg, refId: id }).strict(),
    async run({ board, refId }, t) {
      const { board: b, targetId } = await boardAndTarget(t, board, 'code ref', refId);
      await removal(() => t.ctx.db.call('remove_code_ref', { id: targetId }, t.signal));
      return committed(b.name);
    },
  },

  add_change_note: {
    title: 'Add change note',
    scope: 'board:write',
    description: ADD_NOTE_DESCRIPTION + BOARD_SUFFIX,
    input: z.object({ board: boardArg, ...noteInput, author: z.string().optional() }).strict(),
    async run({ board, author, ...input }, t) {
      const b = await sessionBoard(t, board);
      const anchorId = u64(input.anchorId);
      await nodesOnBoard(t, b, [anchorId]);
      const notes = () => t.ctx.db.read<Row>(sql`SELECT id, board_id, anchor_id, title FROM visible_change_note WHERE board_id = ${b.id}`, t.signal);
      const { text, repeat = '' } = await create(
        t,
        'add_change_note',
        { board, ...input },
        async () => new Set((await notes()).map(n => n.id as bigint)),
        () => t.ctx.db.call('add_change_note', addNoteArgs(b.id, input, author ?? ''), t.signal),
        async before => ownNewIds(before, (await notes()) as never[], b.id, (n: Row) => n.anchorId === anchorId && n.title === input.title)
      );
      return okResult(`${text}${input.schema ? SCHEMA_HINT : ''} board=${b.name}${repeat}`);
    },
  },

  update_change_note: {
    title: 'Update change note',
    scope: 'board:write',
    description: UPDATE_NOTE_DESCRIPTION + BOARD_SUFFIX,
    input: z.object({ board: boardArg, ...noteUpdateInput }).strict(),
    async run({ board, ...input }, t) {
      const { board: b } = await boardAndTarget(t, board, 'change note', input.noteId);
      await absolute(() => t.ctx.db.call('update_change_note', updateNoteArgs(input), t.signal));
      return committed(b.name, input.schema ? `committed${SCHEMA_HINT}` : 'committed');
    },
  },

  remove_change_note: {
    title: 'Remove change note',
    scope: 'board:write',
    annotations: { destructiveHint: true },
    description: REMOVE_NOTE_DESCRIPTION + BOARD_SUFFIX,
    input: z.object({ board: boardArg, noteId: id }).strict(),
    async run({ board, noteId }, t) {
      const { board: b, targetId } = await boardAndTarget(t, board, 'change note', noteId);
      await removal(() => t.ctx.db.call('remove_change_note', { id: targetId }, t.signal));
      return committed(b.name);
    },
  },

  add_threat: {
    title: 'Add threat',
    scope: 'board:write',
    description: ADD_THREAT_DESCRIPTION + BOARD_SUFFIX,
    input: z.object({ board: boardArg, ...threatInput }).strict(),
    async run({ board, author, ...input }, t) {
      const b = await boardOf(t, board);
      const anchorId = u64(input.anchorId);
      await nodesOnBoard(t, b, [anchorId]);
      const threats = () => t.ctx.db.read<Row>(sql`SELECT id, board_id, anchor_id, title FROM visible_threat WHERE board_id = ${b.id}`, t.signal);
      const { text, repeat = '' } = await create(
        t,
        'add_threat',
        { board, ...input },
        async () => new Set((await threats()).map(n => n.id as bigint)),
        () => t.ctx.db.call('add_threat', addThreatArgs(b.id, input, author ?? ''), t.signal),
        async before => ownNewIds(before, (await threats()) as never[], b.id, (n: Row) => n.anchorId === anchorId && n.title === input.title)
      );
      return okResult(`${text} board=${b.name}${repeat}`);
    },
  },

  wait_for_marks: {
    title: 'Wait for marks',
    scope: 'board:write',
    description:
      'Take the review marks people sent on this board: waits up to about 10 s, claims every open mark for your seat, and returns them grouped by shared files. ' +
      'Returns JSON { board, groups: [{ files, marks: [{ mark, claimGen, node, label, note, doc, refs }] }] }, or the text "no marks yet; call wait_for_marks again with the same seat". ' +
      'Marks in one group touch the same files: give a group to one subagent. Answer each mark with reply_to_mark, passing its claimGen. A mark you hold stays yours for 15 minutes while you keep calling this tool or reply_to_mark.' +
      BOARD_SUFFIX,
    input: z.object({ board: boardArg, seat: seatArg }).strict(),
    async run({ board, seat }, t) {
      const b = await boardOf(t, board);
      const owner = safeToken(identityFromClaims(t.ctx.o.issuer, principalSubject(t.ctx.principal)))!;
      const mine = safeToken(seat)!;
      for (;;) {
        await t.ctx.db.call('claim_marks', { boardId: b.id, seat }, t.signal);
        const marks = await t.ctx.db.read<Row>(sql`SELECT * FROM visible_mark WHERE board_id = ${b.id} AND status = 'claimed' AND claimed_by = '${owner}/${mine}'`, t.signal);
        if (marks.length > 0) return okResult(jsonText({ board: b.name, groups: await markGroups(t, b.id, marks) }));
        if (t.deadline - Date.now() <= 5_000) return okResult('no marks yet; call wait_for_marks again with the same seat');
        await new Promise(r => setTimeout(r, 2000));
      }
    },
  },

  watch_marks: {
    title: 'Watch for marks',
    scope: 'board:write',
    description:
      'Get a command that waits in the background for the review marks people send on this board. Returns JSON { board, token, command, expires_in_hours }. ' +
      'Right after drawing, run the command as a background shell task named "Waiting for your red crayon marks on <board name>". Its first line says why it exited. "N mark(s) claimed": it claimed marks for your seat; call wait_for_marks with the same seat, answer every mark with reply_to_mark, then start the command again. "idle:": start it again. "stopped:" (nobody had the board open for 10 minutes): do not restart it; tell the person to open the board and say "review my marks" to resume. The token lasts 12 hours.' +
      BOARD_SUFFIX,
    input: z.object({ board: boardArg, seat: seatArg }).strict(),
    async run({ board, seat }, t) {
      const b = await boardOf(t, board);
      await assertWriter(t, b, 'watch for marks on it');
      const token = await mintMarks(t.ctx.env, principalSubject(t.ctx.principal), b.id, seat);
      return okResult(JSON.stringify({ board: String(b.id), token, command: `npx -y @redcrayonai/draw@1 marks --token ${token}`, expires_in_hours: 12 }, null, 1));
    },
  },

  reply_to_mark: {
    title: 'Reply to mark',
    scope: 'board:write',
    description:
      'Answer a mark you took with wait_for_marks: status fixed (you changed the code) or kept (you left it, and say why). ' +
      'Pass the seat, the mark id and the claimGen wait_for_marks gave you; reply is 1 to 400 characters; files lists the paths you changed (at most 20). ' +
      'If it says the mark was reclaimed, another agent has it: drop it.' +
      BOARD_SUFFIX,
    input: z
      .object({
        board: boardArg,
        seat: seatArg,
        mark: id,
        claimGen: z.number().int().min(0).describe('the claimGen wait_for_marks returned for this mark'),
        status: z.enum(['fixed', 'kept']),
        reply: z.string().min(1).max(MARK_REPLY_MAX),
        files: z.array(z.string().max(MARK_FILE_MAX)).max(MARK_FILES_MAX).describe('paths you changed'),
      })
      .strict(),
    async run({ board, seat, mark, claimGen, status, reply, files }, t) {
      const b = await boardOf(t, board);
      const [m] = await t.ctx.db.read<Row>(sql`SELECT * FROM visible_mark WHERE id = ${u64(mark)}`, t.signal);
      if (!m || m.boardId !== b.id) throw new Refusal(`REJECTED: mark ${mark} is not on this board board=${b.name}`);
      await absolute(() => t.ctx.db.call('reply_mark', { markId: u64(mark), seat, claimGen, status, reply, files }, t.signal));
      return committed(b.name);
    },
  },

  list_marks: {
    title: 'List marks',
    scope: 'board:read',
    annotations: { readOnlyHint: true },
    description:
      'List the review marks on this board with their status (sent, claimed, fixed or kept) and replies; round limits it to one round. ' +
      'Returns JSON { board, marks: [{ mark, node, label, note, round, status, reply, files }] }.' +
      BOARD_SUFFIX,
    input: z.object({ board: boardArg, round: z.number().int().min(1).optional().describe('only this round') }).strict(),
    async run({ board, round }, t) {
      const b = await boardOf(t, board);
      const rows = await t.ctx.db.read<Row>(sql`SELECT * FROM visible_mark WHERE board_id = ${b.id}`, t.signal);
      const marks = rows
        .filter(m => round === undefined || m.round === round)
        .sort((x, y) => (x.id < y.id ? -1 : 1))
        .map(m => ({ mark: m.id, node: m.nodeId, label: m.nodeLabel, note: m.note, round: m.round, status: m.status, reply: m.reply, files: JSON.parse(m.files || '[]') }));
      return okResult(jsonText({ board: b.name, marks }));
    },
  },

  update_threat: {
    title: 'Update threat',
    scope: 'board:write',
    description: UPDATE_THREAT_DESCRIPTION + BOARD_SUFFIX,
    input: z.object({ board: boardArg, ...threatUpdateInput }).strict(),
    async run({ board, ...input }, t) {
      const { board: b } = await boardAndTarget(t, board, 'threat', input.threatId);
      await absolute(() => t.ctx.db.call('update_threat', updateThreatArgs(input), t.signal));
      return committed(b.name);
    },
  },

  remove_threat: {
    title: 'Remove threat',
    scope: 'board:write',
    annotations: { destructiveHint: true },
    description: REMOVE_THREAT_DESCRIPTION + BOARD_SUFFIX,
    input: z.object({ board: boardArg, threatId: id }).strict(),
    async run({ board, threatId }, t) {
      const { board: b, targetId } = await boardAndTarget(t, board, 'threat', threatId);
      await removal(() => t.ctx.db.call('remove_threat', { id: targetId }, t.signal));
      return committed(b.name);
    },
  },

  set_node_doc: {
    title: 'Set node doc',
    scope: 'board:write',
    description: "Replace a node's doc: at most two sentences on what the component is and why it exists. Other fields are untouched." + BOARD_SUFFIX,
    input: z.object({ board: boardArg, nodeId: id, doc: z.string() }).strict(),
    async run({ board, nodeId, doc }, t) {
      const { board: b, targetId } = await boardAndTarget(t, board, 'node', nodeId);
      await absolute(() => t.ctx.db.call('set_node_doc', { nodeId: targetId, doc }, t.signal));
      return committed(b.name);
    },
  },

  set_selection: {
    title: 'Set selection',
    scope: 'board:write',
    description:
      'Show the user which node(s) you are working on: renders as your dashed selection outline through presence. Pass [] to clear when you finish.' + BOARD_SUFFIX,
    input: z.object({ board: boardArg, nodeIds: z.array(id) }).strict(),
    async run({ board, nodeIds }, t) {
      const b = await boardOf(t, board);
      const ids = nodeIds.map(u64);
      await absolute(() => t.ctx.db.call('set_selection', { boardId: b.id, nodeIds: ids }, t.signal));
      return committed(b.name);
    },
  },
};

export const TOOL_NAMES = Object.keys(TOOLS);

/**
 * The board in a canvas link to this origin and database: its slug (`<APP_ORIGIN>/#b=<slug>`), its id (`/?boardId=<id>`, old links only),
 * a Share link's token (`#s=<token>`, from shareHref), or undefined.
 */
export function boardInLink(o: Origins, link: string, dbName: string): SafeU64 | SafeToken | { share: SafeToken } | undefined {
  let url: URL;
  try {
    // a bare fragment (#b=<slug>, #s=<token>) copied out of a link is this deployment's
    url = new URL(link, link.startsWith('#') ? o.app : undefined);
  } catch {
    // a bare board id or slug, as the canvas shows it; a slug can be all digits, and longer than any id
    return safeU64(link) ?? safeToken(link);
  }
  if (url.origin !== new URL(o.app).origin || (url.searchParams.get('db') || dbName) !== dbName) return undefined;
  const hash = new URLSearchParams(url.hash.slice(1));
  const share = hash.get('s');
  if (share !== null) {
    const token = safeToken(share);
    return token === undefined ? undefined : { share: token };
  }
  const slug = hash.get('b');
  if (slug !== null) return safeToken(slug);
  const id = url.searchParams.get('boardId');
  return id === null ? undefined : safeU64(id);
}

/** A board with a session row: code refs, checkpoints and routes need one. */
async function sessionBoard(t: T, board: string) {
  const b = await boardOf(t, board);
  const [session] = await t.ctx.db.read<Row>(sql`SELECT * FROM visible_session WHERE board_id = ${b.id}`, t.signal);
  if (!session) throw new Refusal(noSession(b.name));
  return { ...b, baseSha: session.baseSha as string, repoRoot: session.repoRoot as string };
}

type SessionBoard = Awaited<ReturnType<typeof sessionBoard>>;
const claimBoard = (b: SessionBoard): ClaimBoard => ({ id: b.id, name: b.name, repoRoot: b.repoRoot, baseSha: b.baseSha });

/**
 * The board's rows over HTTP for the flows, counted like every other DB request:
 * the log line's dbCalls and dbMs, and the writes that make a later failure say
 * a write landed.
 */
async function snapshotFor(t: T, board: Parameters<typeof createSnapshot>[2]) {
  const { http, stats } = t.ctx.db;
  const timed = async <R>(run: () => Promise<R>) => {
    const started = Date.now();
    stats.dbCalls += 1;
    try {
      return await run();
    } finally {
      stats.dbMs += Date.now() - started;
    }
  };
  const counted = {
    sqlTypedAs: (...a: Parameters<typeof http.sqlTypedAs>) => timed(() => http.sqlTypedAs(...a)),
    callAs: async (...a: Parameters<typeof http.callAs>) => {
      await timed(() => http.callAs(...a));
      stats.writes += 1;
    },
  };
  return createSnapshot(counted, await t.ctx.db.token(), board);
}

/**
 * The checkout's GitHub remote, with HEAD when it is pushed and the dirty cited paths, for the canvas's
 * "Open on GitHub" (RC-690). Called once the call has committed, so a refusal here (a module published
 * before the reducer existed, a board the agent only reads) costs the links and not the answer.
 */
async function recordRemote(t: T, boardId: SafeU64, c: ClaimedCapture): Promise<void> {
  if (!c.remote) return;
  const checkpoint = c.kind === 'checkpoint';
  const args = { boardId, remoteUrl: c.remote, pushedHead: checkpoint && c.pushed ? c.head : '', dirtyPaths: checkpoint ? (c.dirty ?? []) : [] };
  await absolute(() => t.ctx.db.call('set_session_remote', args, t.signal)).catch(() => {});
}

/** The session flows' deps on a claimed capture: a fresh progress map (Decision 17), secrets scanned before writes. */
async function flowDeps(t: T, boardId: SafeU64, capture: ClaimedCapture, partial = false): Promise<SessionDeps> {
  const snap = await snapshotFor(t, boardId);
  return { ...captureDeps(capture, boardId), call: guardSecrets(snap.call, partial), followCodeRef: true, progress: new Map() };
}

/** A session flow's own refusals (one sentence each) become REJECTED with the board; nothing else does. */
async function inFlow<R>(board: string | undefined, run: () => Promise<R>): Promise<R> {
  try {
    return await run();
  } catch (err) {
    throw flowSentence(err, board);
  }
}

/**
 * A capture is used up by its first claim, so a client's re-sent request (its
 * stream broke) would be refused as "already used" although the first one
 * committed. The USER DO's window gives the repeat the first one's answer.
 */
async function onceForCapture(t: T, call: [string, Record<string, unknown>], run: () => Promise<ToolResult>): Promise<ToolResult> {
  // The same tool with the same arguments, capture included: a capture reused for another call is still refused.
  const scopedCall = t.ctx.principal.machine ? [principalSubject(t.ctx.principal), ...call] : call;
  const key = `capture:${await sha256(JSON.stringify(scopedCall))}`;
  const claim = await t.ctx.ledger.claim(key);
  let text: string | null = null;
  try {
    // claim can wait for another request: current policy must be checked after that wait.
    await assertMachineBoardCall(t, call[1]);
    if (!claim.first) return okResult(claim.text + sameCall(claim.ageS));
    const result = await run();
    if (!result.isError) text = result.content[0]?.text ?? null;
    return result;
  } finally {
    if (claim.first) await t.ctx.ledger.settle(key, text);
  }
}

/** Cached machine responses carry the same board boundary as a fresh write. */
async function assertMachineBoardCall(t: T, args: Record<string, unknown>): Promise<void> {
  if (!t.ctx.principal?.machine) return;
  let board: { id: SafeU64; name: string };
  if (typeof args.board === 'string') board = await boardOf(t, args.board);
  else {
    if (typeof args.link !== 'string') throw new Refusal('REJECTED: service accounts edit existing boards; pass a board link. Nothing was written.');
    const found = boardInLink(t.ctx.o, args.link, t.ctx.env.DB_NAME);
    if (found === undefined || typeof found === 'object') throw new Refusal(linkNotFound(args.link));
    const [row] = await t.ctx.db.read<Row>(typeof found === 'bigint' ? sql`SELECT * FROM visible_board WHERE id = ${found}` : sql`SELECT * FROM visible_board WHERE slug = '${found}'`, t.signal);
    if (!row) throw new Refusal(linkNotFound(args.link));
    board = { id: row.id, name: row.name };
  }
  await assertWriter(t, board, 'reuse a captured operation on it');
}

/** Every file the board's refs and source: edges need, after a checkpoint. */
async function boardCitedPaths(t: T, boardId: SafeU64): Promise<string[]> {
  const [refs, edges] = await Promise.all([
    t.ctx.db.read<Row>(sql`SELECT path FROM visible_code_ref WHERE board_id = ${boardId}`, t.signal),
    t.ctx.db.read<Row>(sql`SELECT evidence FROM visible_edge WHERE board_id = ${boardId}`, t.signal),
  ]);
  return citedPaths(refs as { path: string }[], edges as { evidence: string }[]);
}

/** The claimed marks with their node's doc and code refs, grouped by the files they share. */
async function markGroups(t: T, boardId: SafeU64, marks: Row[]) {
  const [nodes, refs] = await Promise.all([
    t.ctx.db.read<Row>(sql`SELECT * FROM visible_node WHERE board_id = ${boardId}`, t.signal),
    t.ctx.db.read<Row>(sql`SELECT * FROM visible_code_ref WHERE board_id = ${boardId}`, t.signal),
  ]);
  const docs = new Map(nodes.map(n => [n.id as bigint, String(n.doc ?? '')]));
  const refsOf = (nodeId: bigint) =>
    refs.filter(r => r.targetKind === 'node' && r.targetId === nodeId).map(r => ({ path: r.path, symbol: r.symbol, startLine: r.startLine, endLine: r.endLine }));
  const byId = new Map(marks.map(m => [m.id as bigint, m]));
  const grouped = groupByFiles(marks.map(m => ({ id: m.id as bigint, paths: refsOf(m.nodeId).map(r => r.path as string) })));
  return grouped.map(ids => {
    const items = ids.map(i => {
      const m = byId.get(i)!;
      return { mark: m.id, claimGen: m.claimGen, node: m.nodeId, label: m.nodeLabel, note: m.note, doc: docs.get(m.nodeId) ?? '', refs: refsOf(m.nodeId) };
    });
    return { files: [...new Set(items.flatMap(m => m.refs.map(r => r.path as string)))].sort(), marks: items };
  });
}

const jsonText = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1);

const NO_CAPTURE_NOTE = 'not a git checkout: drawing works; code refs and checkpoints are off on this board';
const OTHER_CHECKOUT_NOTE = 'code refs and checkpoints work only on boards your agent opened from this checkout: drawing works here';

/**
 * The session board name for `name` from this checkout (spec §4 start_session):
 * the account's session board among name, name (2) … name (9) that tracks this
 * checkout re-adopts; otherwise the first of those names the account has no board of.
 */
async function sessionName(t: T, name: string, toplevel: string): Promise<{ name: string; suffixed: boolean; boardId?: bigint }> {
  const mine = await t.ctx.db.read<Row>(sql`SELECT * FROM my_boards`, t.signal);
  const candidates = [name, ...[2, 3, 4, 5, 6, 7, 8, 9].map(k => `${name.slice(0, SESSION_NAME_MAX - 4)} (${k})`)];
  const sessions = mine.filter(b => (b.access === 'owner' || b.access === 'grant') && b.isSession && candidates.includes(b.name));
  const roots = await Promise.all(
    sessions.map(async b => [b.name as string, (await t.ctx.db.read<Row>(sql`SELECT repo_root FROM visible_session WHERE board_id = ${b.boardId as SafeU64}`, t.signal))[0]?.repoRoot, b.boardId as bigint] as const)
  );
  const readopt = candidates.map(c => roots.find(([n, root]) => n === c && root === toplevel)).find(Boolean);
  const free = candidates.find(c => !mine.some(b => b.name === c));
  const chosen = readopt?.[0] ?? free;
  if (chosen === undefined) {
    throw new Refusal(`REJECTED: every name from "${name}" to "${name} (9)" tracks another checkout. Nothing was written. Call start_session with another name.`);
  }
  return { name: chosen, suffixed: chosen !== name, boardId: readopt?.[2] };
}

/** Write a route change, then answer with the route as the flows see it. */
async function routeResult(t: T, b: { id: SafeU64; name: string }, write: () => Promise<void>): Promise<ToolResult> {
  await write();
  const snap = await snapshotFor(t, b.id);
  const route = await snap.call('read route', async conn => routeSnapshot(conn, b.id)).catch(() => undefined);
  return okResult(JSON.stringify({ board: b.name, route }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
}

/** Presence before the first focus: an empty selection on the board when the agent has none there. */
async function showPresence(t: T, boardId: SafeU64) {
  const me = identityFromClaims(t.ctx.o.issuer, principalSubject(t.ctx.principal));
  const rows = await t.ctx.db.read<Row>(sql`SELECT * FROM visible_selection WHERE board_id = ${boardId}`, t.signal);
  if (!rows.some(r => r.identity === me)) await absolute(() => t.ctx.db.call('set_selection', { boardId, nodeIds: [] }, t.signal));
}

/** The hosted agent's identity and its person's browser identity (Decision 24). */
const hostedPair = ({ o, principal }: CallContext) => ({
  agent: identityArg(identityFromClaims(o.issuer, `agent:${principal.userId}`)),
  owner: identityArg(identityFromClaims(o.idp, principal.userId)),
});

/** Only auth.ts's devAuth branch makes this principal (DEV_AUTH=1 and a localhost request). */
const devCaller = ({ env, principal }: CallContext) => env.DEV_AUTH === '1' && principal.userId === 'user_dev' && principal.clientId === 'dev';

const DEV_LINK_NOTE =
  'If a board link shows as unavailable, open this once in the browser you use for the canvas and press "Link this agent to your dashboard". A newer start_session replaces this link.';

/**
 * Local stack only: the dev agent's owner identity is one no browser can present, so offer the
 * person a one-time code (as the stdio agent does) to link the agent to their own browser. Offered on
 * every call: the first browser to redeem a code consumes it, and a new browser must be able to link again. Best effort.
 */
async function devLinkOffer(t: T): Promise<Record<string, string>> {
  try {
    const code = newLinkCode();
    await t.ctx.db.call('offer_agent_link', { code }, t.signal);
    return { dashboard: dashboardLinkUrl(DEFAULT_DASHBOARD_URL, t.ctx.env.DB_NAME, code), dashboardNote: DEV_LINK_NOTE };
  } catch {
    return {};
  }
}

/** Grant the caller's agent a board its person owns; false when the module refuses (not theirs, or no link yet). */
async function grantOwnBoard(t: T, board: string): Promise<boolean> {
  if (t.ctx.principal.machine) return false;
  try {
    await t.ctx.service.call('grant_hosted_agent_board', { ...hostedPair(t.ctx), board }, t.signal);
    return true;
  } catch (err) {
    if (err instanceof DbError && err.status === 530) return false;
    throw err;
  }
}

/**
 * A Share link's board: opened as any visitor opens it (the agent reads it, as link sharing allows),
 * then granted for editing when it is the person's own board. Undefined when the link is not shared.
 */
async function boardOfShare(t: T, token: SafeToken): Promise<Row | undefined> {
  const { db } = t.ctx;
  try {
    await db.call('open_shared_link', { token }, t.signal);
  } catch (err) {
    if (err instanceof DbError && err.status === 530) return undefined;
    throw err;
  }
  const mine = await db.read<Row>(sql`SELECT * FROM my_boards`, t.signal);
  const boardId = mine.find(b => b.linkToken === token)?.boardId as SafeU64 | undefined;
  if (boardId === undefined) return undefined;
  await grantOwnBoard(t, String(boardId));
  return (await db.read<Row>(sql`SELECT * FROM visible_board WHERE id = ${boardId}`, t.signal))[0];
}

// ---------- the gate ----------

// Users whose agent joined, and whose agent was linked, from this isolate (Decision 24: once per user per isolate).
const joined = new Set<string>();
const linked = new Set<string>();

// Best effort, each step on its own: drawing must not fail because the link or
// the name did not land (an unseeded service identity, a DB blip). A step that
// failed is tried again on the next call.
async function ensureAgent(ctx: CallContext, info: UserInfo, signal: AbortSignal) {
  const { principal } = ctx;
  const note = (step: string, err: unknown) =>
    console.error(JSON.stringify({ event: 'agent.link_failed', reqId: ctx.reqId, userId: principal.userId, ensureAgent: step, error: errorKind(err) }));
  if (!principal.machine && !linked.has(principal.userId) && !devCaller(ctx)) {
    try {
      await ctx.service.call('link_hosted_agent', hostedPair(ctx), signal);
      linked.add(principal.userId);
    } catch (err) {
      note('link', err);
    }
  }
  const subject = principalSubject(principal);
  if (!joined.has(subject)) {
    try {
      await ctx.db.call('join_board', { displayName: principal.machine ? info.name : `agent of ${info.name}`, kind: 'agent' }, signal);
      joined.add(subject);
    } catch (err) {
      note('join', err);
    }
  }
}

// The flows' own refusals: one actionable sentence each (session.ts, routes.ts, snippet.ts, git.ts).
const FLOW_ERRORS = new Set(['Error', 'MissingFileError', 'BinaryFileError', 'GitTimeoutError', 'GitOutputTooLargeError']);

/** A flow's sentence becomes REJECTED with the board, as the stdio server words it; anything else is left to scrub(). */
function flowSentence(err: unknown, board: string | undefined): unknown {
  if (err instanceof Refusal) return err;
  if (err instanceof CaptureRejection) return new Refusal(err.message);
  if (err instanceof Error && err.constructor !== DbError && FLOW_ERRORS.has(err.name) && !/[\r\n]/.test(err.message) && !DENYLIST.test(err.message)) {
    return new Refusal(board === undefined ? `REJECTED: ${err.message}` : `REJECTED: ${err.message} board=${board}`);
  }
  return err;
}

async function invoke(name: string, def: ToolDef, args: Record<string, unknown>, ctx: CallContext, span?: Span): Promise<ToolResult> {
  const started = Date.now();
  // The log and Analytics Engine carry the board's id only; texts name the board.
  const board = typeof args.board === 'string' ? args.board : '';
  let boardName: string | undefined;
  let outcome: Outcome = 'ok';
  let status = 200;
  let ref: string | undefined;
  let original: string | undefined;
  let writesBefore = ctx.db.stats.writes;
  const t: T = { ctx, signal: AbortSignal.timeout(TOOL_BUDGET_MS), named: n => (boardName = n), deadline: started + TOOL_BUDGET_MS };
  try {
    if (!ctx.principal.scopes.includes(def.scope)) throw new Refusal('REJECTED: this credential does not allow this operation. Nothing was written.');
    const limited = ctx.env.CALLS_RL && !(await ctx.env.CALLS_RL.limit({ key: ctx.principal.userId })).success;
    if (limited) {
      outcome = 'ratelimited';
      return errorResult(rateLimited(60));
    }
    if (!(await ctx.quota.check(ctx.principal.userId, 1))) {
      outcome = 'limited';
      return errorResult(quotaSpent(ctx.o.support));
    }
    const info = await ctx.user();
    const limit = (PLANS[info.plan] ?? PLANS.free).callsPerMonth;
    const now = new Date();
    if (!(await ctx.ledger.charge(monthOf(now), limit)).ok) {
      outcome = 'limited';
      return errorResult(planLimit(limit, monthName(now), ctx.o.support));
    }
    await ensureAgent(ctx, info, t.signal);
    writesBefore = ctx.db.stats.writes; // link and join are not this call's writes
    const run = () => def.run(args, t);
    return typeof args.capture === 'string' ? await onceForCapture(t, [name, args], run) : await run();
  } catch (err) {
    const s = scrub(err, { write: def.scope === 'board:write', board: boardName });
    outcome = s.outcome;
    status = s.status ?? 200;
    ref = s.ref;
    original = s.original;
    let text = s.text;
    // A write of this call committed before the failure: say so, never "Nothing was written".
    if (ctx.db.stats.writes > writesBefore && text.includes('Nothing was written.')) {
      if (s.outcome === 'unavailable' || s.outcome === 'unconfirmed') {
        ref ??= s.ref ?? newRef();
        text = partialWrite(ref);
        outcome = 'unconfirmed';
      } else {
        text = text.replace('Nothing was written.', EARLIER_WRITE);
      }
    }
    return errorResult(text);
  } finally {
    // reqId joins the trace to its log line; status error marks our failures, not the caller's.
    span?.setAttributes({ tool: name, outcome, status, reqId: ctx.reqId, cold: ctx.cold });
    if (outcome === 'unavailable' || outcome === 'unconfirmed') span?.setStatus({ code: 'error' });
    ctx.log(
      {
        reqId: ctx.reqId,
        userId: ctx.principal.userId,
        clientId: ctx.principal.clientId,
        via: ctx.principal.via,
        tool: name,
        board,
        outcome,
        status,
        dbCalls: ctx.db.stats.dbCalls,
        dbMs: ctx.db.stats.dbMs,
        totalMs: Date.now() - started,
        cold: ctx.cold,
        version: version(ctx.env),
      },
      ref,
      original
    );
  }
}

export const INSTRUCTIONS = `Use draw to keep a live board of what you build for the user to watch.
1. Call start_session first: name = the git branch, or link = a board link the user gave you. Pass the id it returns as board on every other tool.
2. Relay the url it returns to the user once, verbatim, before any other tool call.
3. Draw the components you are about to change (create_node) before your first file edit, then keep the board current as you work. Send writes that do not need each other's results in one message: all nodes of a pass, then their edges and refs.
4. Cite only lines you have read: create_edge evidence "source:<path>:<line>", and add_code_ref for the symbols you touch.
5. When you write a migration or another destructive change, call add_change_note and cite every reader you find with add_code_ref.
6. When a SIEM alert names a service on the board, call add_threat with stage compromised; for a scanner finding use stage vulnerable, only critical or high CVEs with a fix or on KEV.
7. Code refs, source citations and checkpoints need a capture of the user's checkout. With the redcrayon plugin it is filled in for you; otherwise run npx -y @redcrayonai/draw@1 capture … in the project, as the tool texts say, and pass the id it prints as capture.
8. Call mark_checkpoint before every git commit and before your final answer.
9. Failures start with REJECTED (act on the sentence), UNAVAILABLE (wait the stated time, then call again) or UNCONFIRMED (call get_board before any retry).
10. After drawing, call watch_marks with the seat start_session returned and run its command as a background task named "Waiting for your red crayon marks on <board name>". When it prints N mark(s) claimed, call wait_for_marks with that seat, give each group to a subagent if you can, answer every mark with reply_to_mark, then run the command again. On idle: run it again. On stopped: do not; tell the person how to resume. Without background tasks, call wait_for_marks in a loop.`;

export function createServer(ctx: CallContext): McpServer {
  const server = new McpServer(
    { name: 'draw', title: 'draw', version: version(ctx.env), icons: [{ src: ctx.o.icon, mimeType: 'image/svg+xml' }] },
    { instructions: INSTRUCTIONS }
  );
  for (const [name, def] of Object.entries(TOOLS)) {
    server.registerTool(
      name,
      { title: def.title, description: def.description, inputSchema: def.input, annotations: { ...def.annotations } },
      (async (args: Record<string, unknown>) =>
        ctx.tracing ? ctx.tracing.enterSpan(`tool.${name}`, span => invoke(name, def, args, ctx, span)) : invoke(name, def, args, ctx)) as never
    );
  }
  return server;
}
