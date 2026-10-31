import type { DbConnection } from './module_bindings/index';
import type { Node, Edge, CodeRef, Chart } from './module_bindings/types';
import { showError } from './chrome';
import { CHART_NOT_LOADED, type LibraryPayloadV1 } from './library';
import { ICON_NODE_KINDS } from '../../module/src/node-icons';

/**
 * Undo/redo scoped to this client's own operations, implemented as inverse
 * reducer calls. If an inverse call is rejected because the world moved on,
 * the error surfaces and the entry is dropped — never forced.
 */
export interface HistoryEntry {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

/** A code ref as it was before a delete, with its line hashes (RC-690) so undo can put them back. */
type RefSnapshot = CodeRef & { lineHashes?: string };

export class History {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private capture: HistoryEntry[] | null = null;
  // Batches share the single `capture` field, so overlapping ones would steal
  // each other's entries. Run them one at a time on this tail chain.
  private batchTail: Promise<void> = Promise.resolve();
  // Undo/redo steps run one at a time too: a restore records its new row id
  // (Ops aliases) before the next step looks it up.
  private stepTail: Promise<void> = Promise.resolve();

  push(entry: HistoryEntry): void {
    if (this.capture) {
      this.capture.push(entry);
      return;
    }
    this.past.push(entry);
    this.future = [];
  }

  /** Collapse every entry pushed inside `fn` into one undoable entry, so a
   * multi-row edit reverses with a single Cmd+Z (matching node deletion). */
  async batch(label: string, fn: () => Promise<void>): Promise<void> {
    const run = this.batchTail.then(() => this.runBatch(label, fn));
    // Keep the chain alive even if this batch rejects, so a failure never
    // wedges every later batch.
    this.batchTail = run.catch(() => {});
    return run;
  }

  private async runBatch(label: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.capture;
    const buf: HistoryEntry[] = [];
    this.capture = buf;
    try {
      await fn();
    } finally {
      this.capture = prev;
      // Commit in the finally: a batch that rejects partway (e.g. the server's
      // focal limit refusing the third node) has still applied the earlier
      // rows, and those must stay undoable. Dropping buf here would leave the
      // board changed with no history entry to reverse it.
      this.commitBatch(label, buf);
    }
  }

  private commitBatch(label: string, buf: HistoryEntry[]): void {
    if (buf.length === 0) {
      return;
    }
    if (buf.length === 1) {
      this.push(buf[0]);
      return;
    }
    this.push({
      label,
      undo: async () => {
        for (let i = buf.length - 1; i >= 0; i--) {
          await buf[i].undo();
        }
      },
      redo: async () => {
        for (const e of buf) {
          await e.redo();
        }
      },
    });
  }

  undo(): Promise<void> {
    return (this.stepTail = this.stepTail.then(() => this.runUndo()));
  }

  redo(): Promise<void> {
    return (this.stepTail = this.stepTail.then(() => this.runRedo()));
  }

  // Both catch every error, so the step chain never rejects.
  private async runUndo(): Promise<void> {
    const entry = this.past.pop();
    if (!entry) {
      return;
    }
    try {
      await entry.undo();
      this.future.push(entry);
    } catch (err) {
      showError(`undo of "${entry.label}" rejected — dropped: ${(err as Error).message}`);
    }
  }

  private async runRedo(): Promise<void> {
    const entry = this.future.pop();
    if (!entry) {
      return;
    }
    try {
      await entry.redo();
      this.past.push(entry);
    } catch (err) {
      showError(`redo of "${entry.label}" rejected — dropped: ${(err as Error).message}`);
    }
  }
}

/**
 * Reducer calls do not return created row ids, and the 2.8 SDK's row events
 * carry no caller identity — so watch the table for an insert whose fields
 * match what we asked for and capture its id.
 */
// Rows already claimed by a capture, so two concurrent captures with
// identical fields can never resolve to the same id. Ids are autoInc and
// never reused, so claimed ids stay claimed.
const claimedIds = new Set<bigint>();

function captureInsert<Row extends { id: bigint }>(
  table: {
    onInsert: (cb: (ctx: any, row: Row) => void) => void;
    removeOnInsert: (cb: (ctx: any, row: Row) => void) => void;
  },
  matches: (row: Row) => boolean,
  reducerCall: () => Promise<void>
): Promise<bigint> {
  return new Promise((resolve, reject) => {
    const cb = (_ctx: any, row: Row) => {
      if (claimedIds.has(row.id) || !matches(row)) {
        return;
      }
      claimedIds.add(row.id);
      table.removeOnInsert(cb);
      resolve(row.id);
    };
    table.onInsert(cb);
    reducerCall().catch(err => {
      table.removeOnInsert(cb);
      reject(err);
    });
  });
}

/**
 * An undo write that carries a snapshot's code text. A board that keeps no code
 * (old text not wiped yet, or consent turned off since the delete) refuses the
 * text with the module's code rule; the same write without it restores the rest.
 */
async function textless<T>(write: (withText: boolean) => Promise<T>): Promise<T> {
  try {
    return await write(true);
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith('code rule:'))) throw err;
    return write(false);
  }
}

/** The subset of node fields update_node can patch (each merged by option). */
export type NodePatch = Partial<{
  label: string;
  sublabel: string;
  token: string;
  focal: boolean;
  kind: string;
  // Sub-project C freeform styling. updateNodeAction snapshots whichever keys
  // a patch carries, so undo works for these with no extra plumbing.
  shape: string;
  color: string;
  strokeStyle: string;
  size: string;
}>;

export interface NodeFields {
  boardId: bigint;
  label: string;
  sublabel: string;
  x: number;
  y: number;
  w: number;
  h: number;
  token: string;
  focal: boolean;
  kind: string;
  doc?: string;
  imported?: boolean;
  // Style travels with the row: without these, duplicating a styled node or
  // undoing its deletion would silently reset it to the kind default.
  shape?: string;
  color?: string;
  strokeStyle?: string;
  size?: string;
  sourceKey?: string;
  /** A library icon id (spec 2026-10-18): the node is made by create_icon_node,
   *  node and icon in one transaction, so duplicates, undone deletes and
   *  library inserts keep it. */
  icon?: string;
}

/**
 * An edge's hand-set style (RC-688). Colour and line live on the edge row;
 * weight lives in visible_edge_weight, which holds a row only for medium or
 * bold, and motion in visible_edge_motion, a row only for an animated edge.
 * A new edge starts at DEFAULT_EDGE_STYLE.
 */
export interface EdgeStyle {
  color: string;
  strokeStyle: string;
  weight: string;
  motion: string;
  motionSpeed: string;
}

export const DEFAULT_EDGE_STYLE: Readonly<EdgeStyle> = { color: '', strokeStyle: 'solid', weight: 'regular', motion: 'none', motionSpeed: 'normal' };

/** What create_chart takes. `options` is the options JSON ('' reads as '{}');
 *  an empty `source` lets the server fill in the caller's default. */
export interface ChartFields {
  boardId: bigint;
  label: string;
  sublabel: string;
  x: number;
  y: number;
  w: number;
  h: number;
  type: string;
  csv: string;
  options: string;
  source: string;
}

/** The chart fields set_chart_data can patch; an omitted field keeps its value. */
export interface ChartPatch {
  type?: string;
  csv?: string;
  options?: string;
  source?: string;
}

export class Ops {
  /** Per chart: the last data save in line (settled, never rejecting). */
  private chartSaves = new Map<bigint, Promise<void>>();
  /** Undo of a delete and redo of a create make the row again under a new id,
   *  but older entries still hold the old one: old id → newer id, per table
   *  (node and edge ids are separate sequences). Ids are never reused. */
  private aliases = { node: new Map<bigint, bigint>(), edge: new Map<bigint, bigint>() };

  constructor(
    private conn: DbConnection,
    private myIdentityHex: string,
    readonly history: History
  ) {}

  /** The id the row with (old) id `id` lives under now. */
  private cur(kind: 'node' | 'edge', id: bigint): bigint {
    for (let next = this.aliases[kind].get(id); next !== undefined; next = this.aliases[kind].get(id)) {
      id = next;
    }
    return id;
  }

  /** Record that the row once `old` (if any) is now `now`. */
  private link(kind: 'node' | 'edge', old: bigint | undefined, now: bigint): void {
    if (old !== undefined) {
      this.aliases[kind].set(this.cur(kind, old), now);
    }
  }

  /** The library icon a node shows, when its row has arrived and its kind can show one. */
  private iconOf(n: { id: bigint; kind: string }): string | undefined {
    if (!ICON_NODE_KINDS.includes(n.kind)) return undefined;
    return this.conn.db.visibleNodeIcon?.nodeId.find(n.id)?.icon || undefined;
  }

  private liveNode(id: bigint): Node | undefined {
    const now = this.cur('node', id);
    return [...this.conn.db.visibleNode.iter()].find(n => n.id === now);
  }

  /** An undo or redo writes back an old value only while the row still holds
   *  what this entry wrote last; otherwise someone changed it since and the
   *  entry is dropped (History catches this) rather than clobbering them. */
  private assertUnchanged(row: object | undefined, wrote: object): void {
    if (row && Object.entries(wrote).some(([k, v]) => (row as Record<string, unknown>)[k] !== v)) {
      throw new Error('it was changed by someone else since');
    }
  }

  createNode(fields: NodeFields): Promise<bigint> {
    return captureInsert(
      this.conn.db.visibleNode,
      row =>
        row.boardId === fields.boardId &&
        row.label === fields.label &&
        row.x === fields.x &&
        row.y === fields.y &&
        row.w === fields.w &&
        row.h === fields.h,
      () => (fields.icon ? this.conn.reducers.createIconNode({ ...fields, icon: fields.icon }) : this.conn.reducers.createNode(fields))
    ).then(async id => {
      if (fields.sourceKey) await this.conn.reducers.setArchitectureNodeKey({ nodeId: id, sourceKey: fields.sourceKey });
      return id;
    });
  }

  createEdge(fields: {
    boardId: bigint; fromNode: bigint; toNode: bigint; label: string;
    evidence?: string; evidenceSnippet?: string; evidenceStatus?: string; relation?: string; imported?: boolean;
  }): Promise<bigint> {
    const intent = this.conn.db.visibleArchitectureVersion?.boardId.find(fields.boardId)?.assertionMode === 'intent';
    const evidence = fields.evidence ?? (intent ? '' : `human:${this.myIdentityHex}`);
    return captureInsert(
      this.conn.db.visibleEdge,
      row =>
        row.boardId === fields.boardId &&
        row.fromNode === fields.fromNode &&
        row.toNode === fields.toNode &&
        row.label === fields.label,
      () =>
        this.conn.reducers.createEdge({
          boardId: fields.boardId,
          fromNode: fields.fromNode,
          toNode: fields.toNode,
          label: fields.label,
          evidence,
          evidenceSnippet: fields.evidenceSnippet,
          evidenceStatus: fields.evidenceStatus,
          imported: fields.imported,
        })
    ).then(async id => {
      if (fields.relation !== undefined && intent) await this.conn.reducers.setArchitectureEdgeRelation({ edgeId: id, relation: fields.relation });
      return id;
    });
  }

  /** Create a node as a user action, with undo. */
  async createNodeAction(fields: NodeFields): Promise<bigint> {
    const id = await this.createNode(fields);
    this.history.push({
      label: `create "${fields.label}"`,
      undo: () => this.conn.reducers.deleteNode({ nodeId: this.cur('node', id) }),
      redo: async () => {
        this.link('node', id, await this.createNode(fields));
      },
    });
    return id;
  }

  /** Create a chart: create_chart inserts the node and its chart row in one
   *  transaction. Only a node of kind 'chart' matches, so a plain node with
   *  the same label at the same spot is never taken for it. */
  createChart(fields: ChartFields): Promise<bigint> {
    return captureInsert(
      this.conn.db.visibleNode,
      row =>
        row.kind === 'chart' &&
        row.boardId === fields.boardId &&
        row.label === fields.label &&
        row.x === fields.x &&
        row.y === fields.y,
      () => this.conn.reducers.createChart(fields)
    );
  }

  /** Create a chart as a user action, with undo. */
  async createChartAction(fields: ChartFields): Promise<bigint> {
    const id = await this.createChart(fields);
    this.history.push({
      label: `create "${fields.label}"`,
      undo: () => this.conn.reducers.deleteNode({ nodeId: this.cur('node', id) }),
      redo: async () => {
        this.link('node', id, await this.createChart(fields));
      },
    });
    return id;
  }

  /**
   * Change a chart's data, with undo. Undo restores only the fields this edit
   * changed, so a collaborator's later change to another field survives (as
   * updateNodeAction does). New numbers (type or csv) can also rewrite the
   * source on the server, so their undo puts the source back with them.
   * Saves on one chart run one at a time: each waits for the one before it
   * to finish (or fail), then reads `before` from the row. The SDK applies a
   * reducer's row updates before it resolves the call, so that row already
   * holds what the previous save left, including a source the server chose.
   * The chart table is read with `?.` because test fakes (ops.refs.test.ts)
   * have no chart table.
   */
  setChartDataAction(nodeId: bigint, patch: ChartPatch): Promise<void> {
    const save = async () => {
      const live = this.conn.db.visibleChart?.nodeId.find(nodeId);
      if (!live) {
        throw new Error(`node ${nodeId} is not a chart`);
      }
      const newNumbers = patch.type !== undefined || patch.csv !== undefined;
      const before: ChartPatch = {};
      for (const k of ['type', 'csv', 'options', 'source'] as const) {
        if (patch[k] !== undefined || (k === 'source' && newNumbers)) {
          before[k] = live[k];
        }
      }
      const call = (p: ChartPatch) =>
        this.conn.reducers.setChartData({ nodeId: this.cur('node', nodeId), type: p.type, csv: p.csv, options: p.options, source: p.source });
      const row = () => this.conn.db.visibleChart?.nodeId.find(this.cur('node', nodeId)) ?? undefined;
      await call(patch);
      // What the save left, read back: the server may rewrite the source or options.
      const saved = row();
      const after = Object.fromEntries(Object.keys(before).map(k => [k, saved?.[k as keyof ChartPatch]]));
      this.history.push({
        label: 'edit chart data',
        undo: () => { this.assertUnchanged(row(), after); return call(before); },
        redo: () => { this.assertUnchanged(row(), before); return call(patch); },
      });
    };
    const run = (this.chartSaves.get(nodeId) ?? Promise.resolve()).then(save);
    // The tail swallows the error (the caller still gets it from `run`), so a
    // refused save never wedges the saves queued behind it.
    this.chartSaves.set(nodeId, run.catch(() => {}));
    return run;
  }

  /** Move a set of nodes (single or group drag), with undo. */
  async moveNodesAction(
    moves: Array<{ nodeId: bigint; from: { x: number; y: number }; to: { x: number; y: number } }>
  ): Promise<void> {
    // Sent together (the connection keeps their order), not one round trip each.
    const results = await Promise.allSettled(
      moves.map(m => this.conn.reducers.moveNode({ nodeId: m.nodeId, x: m.to.x, y: m.to.y }))
    );
    // A node deleted mid-drag fails alone: the moves that landed stay undoable.
    const done = moves.filter((_, i) => results[i].status === 'fulfilled');
    const apply = async (dir: 'to' | 'from', wrote: 'to' | 'from') => {
      for (const m of done) {
        this.assertUnchanged(this.liveNode(m.nodeId), m[wrote]);
      }
      await Promise.all(done.map(m => this.conn.reducers.moveNode({ nodeId: this.cur('node', m.nodeId), x: m[dir].x, y: m[dir].y })));
    };
    if (done.length > 0) {
      this.history.push({
        label: done.length === 1 ? 'move node' : `move ${done.length} nodes`,
        undo: () => apply('from', 'to'),
        redo: () => apply('to', 'from'),
      });
    }
    const failed = results.find(r => r.status === 'rejected');
    if (failed) {
      throw failed.reason;
    }
  }

  /** Resize (and possibly reposition) a node, with undo. */
  async resizeNodeAction(
    nodeId: bigint,
    from: { x: number; y: number; w: number; h: number },
    to: { x: number; y: number; w: number; h: number }
  ): Promise<void> {
    const call = (r: { x: number; y: number; w: number; h: number }, wrote: typeof r) => {
      this.assertUnchanged(this.liveNode(nodeId), wrote);
      return this.conn.reducers.resizeNode({ nodeId: this.cur('node', nodeId), ...r });
    };
    await this.conn.reducers.resizeNode({ nodeId, ...to });
    this.history.push({
      label: 'resize node',
      undo: () => call(from, to),
      redo: () => call(to, from),
    });
  }

  /**
   * Update label/sublabel/token/focal/kind, with undo. `patch` carries only the
   * fields the caller means to change; the update_node reducer merges each field
   * by option, so untouched fields are never echoed back and a collaborator's
   * concurrent edit to one of them is not clobbered. The undo snapshot covers
   * exactly the patched fields. Returns silently if the row is gone.
   */
  async updateNodeAction(nodeId: bigint, patch: NodePatch): Promise<void> {
    const live = [...this.conn.db.visibleNode.iter()].find(n => n.id === nodeId);
    if (!live) {
      return; // deleted remotely
    }
    const before: NodePatch = {};
    for (const key of Object.keys(patch) as (keyof NodePatch)[]) {
      // Restore only what this action changed.
      (before as Record<string, unknown>)[key] = live[key];
    }
    const call = (v: NodePatch, wrote: NodePatch) => {
      this.assertUnchanged(this.liveNode(nodeId), wrote);
      return this.conn.reducers.updateNode({ nodeId: this.cur('node', nodeId), ...v });
    };
    // The server drops the icon of a node that becomes a note; undo puts it back.
    const dropped = patch.kind !== undefined && !ICON_NODE_KINDS.includes(patch.kind) ? this.iconOf(live) : undefined;
    await this.conn.reducers.updateNode({ nodeId, ...patch });
    this.history.push({
      label: `edit "${live.label}"`,
      undo: async () => {
        await call(before, patch);
        if (dropped) await this.conn.reducers.setNodeIcon({ nodeId: this.cur('node', nodeId), icon: dropped });
      },
      redo: () => call(patch, before),
    });
  }

  /** An edge's weight: 'regular' unless visible_edge_weight holds a row for it.
   *  Read with `?.`: test fakes have no weight table. */
  edgeWeight(edgeId: bigint): string {
    return this.conn.db.visibleEdgeWeight?.edgeId.find(edgeId)?.weight ?? DEFAULT_EDGE_STYLE.weight;
  }

  /** An edge's motion and its speed: none unless visible_edge_motion holds a row for it. Read with `?.`, as weight. */
  edgeMotion(edgeId: bigint): { motion: string; motionSpeed: string } {
    const row = this.conn.db.visibleEdgeMotion?.edgeId.find(edgeId);
    return row ? { motion: row.motion, motionSpeed: row.speed } : { motion: DEFAULT_EDGE_STYLE.motion, motionSpeed: DEFAULT_EDGE_STYLE.motionSpeed };
  }

  /** An edge's colour, line, weight and motion as the toolbar shows them. */
  edgeStyle(edge: Pick<Edge, 'id' | 'color' | 'strokeStyle'>): EdgeStyle {
    return { color: edge.color, strokeStyle: edge.strokeStyle, weight: this.edgeWeight(edge.id), ...this.edgeMotion(edge.id) };
  }

  private liveEdge(id: bigint): Edge | undefined {
    const now = this.cur('edge', id);
    return [...this.conn.db.visibleEdge.iter()].find(e => e.id === now);
  }

  /** Write the parts of a style the patch names: colour and line through
   *  update_edge_style, weight through set_edge_weight, motion and its speed
   *  through set_edge_motion (which takes both: the one not named stays). */
  private async writeEdgeStyle(edgeId: bigint, patch: Partial<EdgeStyle>): Promise<void> {
    if (patch.color !== undefined || patch.strokeStyle !== undefined) {
      await this.conn.reducers.updateEdgeStyle({ edgeId, color: patch.color, strokeStyle: patch.strokeStyle });
    }
    if (patch.weight !== undefined) {
      await this.conn.reducers.setEdgeWeight({ edgeId, weight: patch.weight });
    }
    if (patch.motion !== undefined || patch.motionSpeed !== undefined) {
      const now = this.edgeMotion(edgeId);
      await this.conn.reducers.setEdgeMotion({ edgeId, motion: patch.motion ?? now.motion, speed: patch.motionSpeed ?? now.motionSpeed });
    }
  }

  /** Style an edge (colour / line / weight), with undo. Only the fields that
   *  change are written and restored; a patch that changes nothing (the
   *  pressed swatch, Reset on a default edge) writes nothing and adds no
   *  undo step. */
  async updateEdgeStyleAction(edgeId: bigint, patch: Partial<EdgeStyle>): Promise<void> {
    const live = this.liveEdge(edgeId);
    if (!live) {
      return; // deleted remotely
    }
    const now = this.edgeStyle(live);
    const change: Partial<EdgeStyle> = {};
    const before: Partial<EdgeStyle> = {};
    for (const key of Object.keys(patch) as (keyof EdgeStyle)[]) {
      if (patch[key] !== undefined && patch[key] !== now[key]) {
        change[key] = patch[key];
        before[key] = now[key];
      }
    }
    if (Object.keys(change).length === 0) {
      return;
    }
    const call = (v: Partial<EdgeStyle>, wrote: Partial<EdgeStyle>) => {
      const row = this.liveEdge(edgeId);
      this.assertUnchanged(row && this.edgeStyle(row), wrote);
      return this.writeEdgeStyle(this.cur('edge', edgeId), v);
    };
    await this.writeEdgeStyle(edgeId, change);
    this.history.push({
      label: 'style edge',
      undo: () => call(before, change),
      redo: () => call(change, before),
    });
  }

  /**
   * Reapply a restored edge's style. createEdge carries no style arguments, so
   * without this an undone deletion would bring the edge back in default
   * colour, line and weight.
   */
  private async restoreEdgeStyle(edgeId: bigint, style: EdgeStyle): Promise<void> {
    // Only the calls a fresh edge's defaults leave to make.
    const lined = style.color !== DEFAULT_EDGE_STYLE.color || style.strokeStyle !== DEFAULT_EDGE_STYLE.strokeStyle;
    const weighted = style.weight !== DEFAULT_EDGE_STYLE.weight;
    const moving = style.motion !== DEFAULT_EDGE_STYLE.motion;
    await this.writeEdgeStyle(edgeId, {
      ...(lined ? { color: style.color, strokeStyle: style.strokeStyle } : {}),
      ...(weighted ? { weight: style.weight } : {}),
      ...(moving ? { motion: style.motion, motionSpeed: style.motionSpeed } : {}),
    });
  }

  /**
   * Recreate a chart node from its row and its chart data (delete undo,
   * duplicate, library insert). create_chart takes no style or doc, so a styled or focal chart
   * gets one update_node and a chart with a doc one set_node_doc afterwards,
   * as a restored edge gets restoreEdgeStyle. `created` hears the new id
   * before those follow-ups, so a refused one never leaves the chart out of
   * the caller's undo. A refused focal (the board's focal limit, reached
   * since) is dropped and reported; the rest goes on.
   */
  private async copyChart(
    n: Pick<Node, 'boardId' | 'label' | 'sublabel' | 'x' | 'y' | 'w' | 'h' | 'token' | 'shape' | 'color' | 'strokeStyle' | 'size' | 'doc'>,
    data: Pick<Chart, 'type' | 'csv' | 'options' | 'source'> | undefined,
    offset: number,
    focal: boolean,
    created: (id: bigint) => void
  ): Promise<bigint> {
    if (data === undefined) {
      throw new Error(`the data of chart "${n.label}" was not loaded, so it cannot be recreated`);
    }
    const id = await this.createChart({
      boardId: n.boardId,
      label: n.label,
      sublabel: n.sublabel,
      x: n.x + offset,
      y: n.y + offset,
      w: n.w,
      h: n.h,
      type: data.type,
      csv: data.csv,
      options: data.options,
      source: data.source,
    });
    created(id);
    const plain = n.token === 'ink' && n.shape === 'rect' && n.color === '' && n.strokeStyle === 'solid' && n.size === 'm';
    const style = { nodeId: id, token: n.token, shape: n.shape, color: n.color, strokeStyle: n.strokeStyle, size: n.size };
    if (!plain || focal) {
      try {
        await this.conn.reducers.updateNode({ ...style, focal: focal || undefined });
      } catch (err) {
        if (!focal) {
          throw err;
        }
        showError(`"${n.label}" came back without focal: ${(err as Error).message}`);
        if (!plain) {
          await this.conn.reducers.updateNode(style);
        }
      }
    }
    // create_chart takes no doc either; a chart can hold one (set_node_doc).
    if (n.doc !== '') await this.conn.reducers.setNodeDoc({ nodeId: id, doc: n.doc });
    return id;
  }

  /** The code refs on these targets, captured before a delete cascades them away, each with its line hashes (RC-690). */
  private refsOn(kind: 'node' | 'edge', ids: ReadonlySet<bigint>): RefSnapshot[] {
    const hashes = new Map([...(this.conn.db.visibleCodeRefHash?.iter() ?? [])].map(h => [h.refId, h.lineHashes]));
    return [...this.conn.db.visibleCodeRef.iter()]
      .filter(r => r.targetKind === kind && ids.has(r.targetId))
      .map(r => ({ ...r, lineHashes: hashes.get(r.id) }));
  }

  /** The cited line's hash, captured before a delete drops it. */
  private edgeHash(edgeId: bigint): string | undefined {
    return [...(this.conn.db.visibleEdgeEvidenceHash?.iter() ?? [])].find(h => h.edgeId === edgeId)?.lineHash;
  }

  /** Put the hash back on a recreated edge: a source: citation survived uncitedFor, so a member made it. Any text came back with createEdge. */
  private async restoreEdgeHash(edgeId: bigint, evidence: string | undefined, lineHash: string | undefined): Promise<void> {
    if (lineHash !== undefined && evidence?.startsWith('source:')) {
      await this.conn.reducers.setEdgeEvidenceCode({ edgeId, lineHash });
    }
  }

  /** A board member (module isBoardMember): any my_boards access but an opened
   *  link. Only members cite code (U52). No row yet keeps the member path: a
   *  refused undo beats refs silently dropped. */
  private member(boardId: bigint): boolean {
    return [...(this.conn.db.myBoards?.iter() ?? [])].find(r => r.boardId === boardId)?.access !== 'link';
  }

  /** A non-member's restore of a source:-cited edge would be refused (U52),
   *  so it comes back as if drawn by hand: createEdge's default evidence. */
  private uncitedFor<E extends { boardId: bigint; evidence?: string; evidenceSnippet?: string; evidenceStatus?: string }>(e: E): E {
    if (!e.evidence?.startsWith('source:') || this.member(e.boardId)) return e;
    return { ...e, evidence: undefined, evidenceSnippet: undefined, evidenceStatus: undefined };
  }

  /** Re-attach captured refs to the recreated targets (found by alias),
   *  then put back a status other than ok. The checkpoint stamp is the next
   *  one: the server stamps every added ref that way. A non-member's undo
   *  skips them: the module refuses them code refs (U52). */
  private async restoreRefs(refs: RefSnapshot[]): Promise<void> {
    for (const r of refs) {
      if (!this.member(r.boardId)) continue;
      const targetId = this.cur(r.targetKind as 'node' | 'edge', r.targetId);
      const id = await textless(withText => captureInsert(
        this.conn.db.visibleCodeRef,
        row => row.targetKind === r.targetKind && row.targetId === targetId && row.path === r.path && row.symbol === r.symbol,
        () =>
          this.conn.reducers.addCodeRef({
            boardId: r.boardId, targetKind: r.targetKind, targetId, path: r.path, symbol: r.symbol,
            startLine: r.startLine, endLine: r.endLine, blobSha: r.blobSha, snippet: withText ? r.snippet : '', author: r.author,
          })
      ));
      if (r.status !== 'ok') {
        await textless(withText => this.conn.reducers.updateCodeRef({
          id, startLine: r.startLine, endLine: r.endLine, blobSha: r.blobSha, snippet: withText ? r.snippet : '', status: r.status,
        }));
      }
      if (r.lineHashes !== undefined) {
        await this.conn.reducers.setCodeRefHashes({ refId: id, lineHashes: r.lineHashes });
      }
    }
  }

  /** Delete an edge, with undo that recreates it with its evidence and style. */
  async deleteEdgeAction(edge: Edge): Promise<void> {
    const snapshot = {
      boardId: edge.boardId,
      fromNode: edge.fromNode,
      toNode: edge.toNode,
      label: edge.label,
      evidence: edge.evidence || (this.conn.db.visibleArchitectureVersion?.boardId.find(edge.boardId)?.assertionMode === 'intent' ? '' : `human:${this.myIdentityHex}`),
      evidenceSnippet: edge.evidenceSnippet,
      evidenceStatus: edge.evidenceStatus,
      relation: edge.relation,
      imported: edge.imported,
    };
    const style = this.edgeStyle(edge);
    // The server deletes the edge's code refs with it; undo re-attaches them.
    const refs = this.refsOn('edge', new Set([edge.id]));
    const lineHash = this.edgeHash(edge.id);
    const doDelete = () => this.conn.reducers.deleteEdge({ edgeId: this.cur('edge', edge.id) });
    const doRestore = async () => {
      const restored = this.uncitedFor({
        ...snapshot,
        fromNode: this.cur('node', snapshot.fromNode),
        toNode: this.cur('node', snapshot.toNode),
      });
      const id = await textless(withText => this.createEdge(withText ? restored : { ...restored, evidenceSnippet: '' }));
      this.link('edge', edge.id, id);
      await this.restoreEdgeHash(id, restored.evidence, lineHash);
      await this.restoreEdgeStyle(id, style);
      await this.restoreRefs(refs);
    };
    await doDelete();
    this.history.push({ label: 'delete edge', undo: doRestore, redo: doDelete });
  }

  /** Create an edge as a user action, with undo. */
  async createEdgeAction(fields: { boardId: bigint; fromNode: bigint; toNode: bigint; label: string }): Promise<void> {
    const id = await this.createEdge(fields);
    this.history.push({
      label: 'create edge',
      undo: () => this.conn.reducers.deleteEdge({ edgeId: this.cur('edge', id) }),
      redo: async () => {
        const ends = { fromNode: this.cur('node', fields.fromNode), toNode: this.cur('node', fields.toNode) };
        this.link('edge', id, await this.createEdge({ ...fields, ...ends }));
      },
    });
  }

  /**
   * Delete nodes (server cascades their edges), with undo that recreates the
   * nodes and re-attaches the captured edges, remapping ids to the recreated
   * nodes. Aborts the rest of the entry on the first rejection.
   */
  async deleteNodesAction(nodes: Node[], allEdges: Edge[]): Promise<void> {
    const ids = new Set(nodes.map(n => n.id));
    const snapshots: NodeFields[] = nodes.map(n => ({
      boardId: n.boardId,
      label: n.label,
      sublabel: n.sublabel,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      token: n.token,
      focal: n.focal,
      kind: n.kind,
      doc: n.doc,
      imported: n.imported,
      shape: n.shape,
      color: n.color,
      strokeStyle: n.strokeStyle,
      size: n.size,
      sourceKey: n.sourceKey,
      icon: this.iconOf(n),
    }));
    // The chart row goes with the node on delete; keep it for undo. A chart
    // whose row has not arrived could never come back, so it is not deleted.
    const chartRows = new Map<bigint, Chart | undefined>(
      nodes.filter(n => n.kind === 'chart').map(n => [n.id, this.conn.db.visibleChart?.nodeId.find(n.id) ?? undefined])
    );
    if ([...chartRows.values()].includes(undefined)) {
      throw new Error(CHART_NOT_LOADED);
    }
    const attached = allEdges.filter(e => ids.has(e.fromNode) || ids.has(e.toNode));
    // The server deletes these nodes' and edges' code refs with them; undo
    // re-attaches them to the recreated rows.
    const nodeRefs = this.refsOn('node', ids);
    const edgeRefs = this.refsOn('edge', new Set(attached.map(e => e.id)));
    const edgeSnapshots = attached
      .map(e => ({
        id: e.id,
        boardId: e.boardId,
        fromNode: e.fromNode,
        toNode: e.toNode,
        label: e.label,
        evidence: e.evidence,
        evidenceSnippet: e.evidenceSnippet,
        evidenceStatus: e.evidenceStatus,
        relation: e.relation,
        imported: e.imported,
        style: this.edgeStyle(e),
        lineHash: this.edgeHash(e.id),
      }));
    const doDelete = async () => {
      for (const n of nodes) {
        await this.conn.reducers.deleteNode({ nodeId: this.cur('node', n.id) });
      }
    };
    const doRestore = async () => {
      for (let i = 0; i < snapshots.length; i++) {
        const restored = (newId: bigint) => this.link('node', nodes[i].id, newId);
        // create_node refuses kind 'chart': a chart comes back with its data.
        if (nodes[i].kind === 'chart') {
          await this.copyChart(nodes[i], chartRows.get(nodes[i].id), 0, nodes[i].focal, restored);
        } else {
          restored(await this.createNode(snapshots[i]));
        }
      }
      for (const e of edgeSnapshots) {
        const restored = this.uncitedFor({
          boardId: e.boardId,
          fromNode: this.cur('node', e.fromNode),
          toNode: this.cur('node', e.toNode),
          label: e.label,
          evidence: e.evidence || (this.conn.db.visibleArchitectureVersion?.boardId.find(e.boardId)?.assertionMode === 'intent' ? '' : `human:${this.myIdentityHex}`),
          evidenceSnippet: e.evidenceSnippet,
          evidenceStatus: e.evidenceStatus,
          relation: e.relation,
          imported: e.imported,
        });
        const restoredId = await textless(withText => this.createEdge(withText ? restored : { ...restored, evidenceSnippet: '' }));
        await this.restoreEdgeHash(restoredId, restored.evidence, e.lineHash);
        await this.restoreEdgeStyle(restoredId, e.style);
        this.link('edge', e.id, restoredId);
      }
      await this.restoreRefs(nodeRefs);
      await this.restoreRefs(edgeRefs);
    };

    await doDelete();
    this.history.push({
      label: nodes.length === 1 ? `delete "${nodes[0].label}"` : `delete ${nodes.length} nodes`,
      undo: doRestore,
      redo: doDelete,
    });
  }

  /** Duplicate nodes offset on the grid; focal is never copied. */
  async duplicateNodesAction(nodes: Node[]): Promise<bigint[]> {
    const fields: NodeFields[] = nodes.map(n => ({
      boardId: n.boardId,
      label: n.label,
      sublabel: n.sublabel,
      x: n.x + 16,
      y: n.y + 16,
      w: n.w,
      h: n.h,
      token: n.token,
      focal: false,
      kind: n.kind,
      doc: n.doc,
      shape: n.shape,
      color: n.color,
      strokeStyle: n.strokeStyle,
      size: n.size,
      icon: this.iconOf(n),
    }));
    // Snapshot chart data now, so a redo copies what was duplicated.
    const chartRows = new Map<bigint, Chart | undefined>(
      nodes.filter(n => n.kind === 'chart').map(n => [n.id, this.conn.db.visibleChart?.nodeId.find(n.id) ?? undefined])
    );
    let ids: bigint[] = [];
    const create = async () => {
      // A redo recreates in the same order, so the i-th new id replaces the i-th old one.
      const prev = ids;
      ids = [];
      const created = (id: bigint) => {
        this.link('node', prev[ids.length], id);
        ids.push(id);
      };
      for (let i = 0; i < nodes.length; i++) {
        // A chart copies through create_chart with its data. Focal is never
        // copied; the source (even 'sample') travels with the data.
        if (nodes[i].kind === 'chart') {
          await this.copyChart(nodes[i], chartRows.get(nodes[i].id), 16, false, created);
        } else {
          created(await this.createNode(fields[i]));
        }
      }
    };
    // A refusal part-way keeps what was created undoable, as an insert does.
    try {
      await create();
    } finally {
      if (ids.length > 0) {
        this.history.push({
          label: nodes.length === 1 ? 'duplicate node' : `duplicate ${nodes.length} nodes`,
          undo: async () => {
            for (const id of ids) {
              await this.conn.reducers.deleteNode({ nodeId: this.cur('node', id) });
            }
          },
          redo: create,
        });
      }
    }
    return ids;
  }

  /**
   * Insert a saved library item with its top-left at `at` (snapped to the
   * server's 4 px grid) as ONE history entry. Deliberately not a batch of
   * createNodeAction/createEdgeAction entries: their redo would replay the
   * edges against the deleted node ids. Undo deletes the current nodes (the
   * server cascades their edges and chart rows); redo runs the same
   * create-with-remap again. Focal, edge evidence and code refs never copy:
   * inserted edges get this client's default evidence (human:<identity>,
   * '' on intent boards). A rejection part-way keeps what was created
   * undoable, then rethrows the server's sentence.
   */
  async insertLibraryAction(
    name: string,
    payload: LibraryPayloadV1,
    at: { x: number; y: number },
    boardId: bigint
  ): Promise<bigint[]> {
    const ox = Math.round(at.x / 4) * 4;
    const oy = Math.round(at.y / 4) * 4;
    let ids: bigint[] = [];
    let edgeIds: bigint[] = [];
    const insert = async () => {
      // A redo recreates in the same order, so the i-th new id replaces the i-th old one.
      const [prev, prevEdges] = [ids, edgeIds];
      ids = [];
      edgeIds = [];
      const byKey = new Map<number, bigint>();
      for (const { key, chart, ...fields } of payload.nodes) {
        const placed = { ...fields, boardId, x: ox + fields.x, y: oy + fields.y };
        const created = (id: bigint) => {
          this.link('node', prev[ids.length], id);
          ids.push(id);
          byKey.set(key, id);
        };
        // A chart goes through create_chart with its data, then its style and doc.
        if (placed.kind === 'chart') {
          await this.copyChart(placed, chart, 0, false, created);
        } else {
          created(await this.createNode({ ...placed, focal: false }));
        }
      }
      for (const e of payload.edges) {
        const fromNode = byKey.get(e.from);
        const toNode = byKey.get(e.to);
        if (fromNode === undefined || toNode === undefined) {
          continue;
        }
        const edgeId = await this.createEdge({ boardId, fromNode, toNode, label: e.label });
        this.link('edge', prevEdges[edgeIds.length], edgeId);
        edgeIds.push(edgeId);
        await this.restoreEdgeStyle(edgeId, { ...DEFAULT_EDGE_STYLE, color: e.color, strokeStyle: e.strokeStyle, weight: e.weight ?? DEFAULT_EDGE_STYLE.weight });
      }
    };
    try {
      await insert();
    } finally {
      if (ids.length > 0) {
        this.history.push({
          label: `insert "${name}"`,
          undo: async () => {
            for (const id of ids) {
              await this.conn.reducers.deleteNode({ nodeId: this.cur('node', id) });
            }
          },
          redo: insert,
        });
      }
    }
    return ids;
  }
}
