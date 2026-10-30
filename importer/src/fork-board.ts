/**
 * fork-board — deep-copy a board into a new board id, through the same
 * server-validated reducers everything else uses.
 *
 * Copies: nodes (with their library icons), edges, hide sets, hide-set memberships, repo files (only
 * those its source: edges cite when the caller is not a member of the board).
 * Excludes: participants, cursors, selections (presence, not content).
 * Refuses: boards with chart nodes (chart rows are not copied yet).
 *
 * Works within one database or across two (e.g. local -> remote):
 *
 *   SOURCE_URI=ws://localhost:3000 SOURCE_DB=redcrayon \
 *   TARGET_URI=wss://db.example TARGET_DB=redcrayon \
 *     npm run fork -- --board brev-g-1b --to brev-g-1b-share
 *
 * SOURCE_URI/SOURCE_DB fall back to SPACETIME_URI/SPACETIME_DB; TARGET_*
 * fall back to SOURCE_*.
 *
 * The copy is verified field-by-field against the source before the script
 * reports success, and the script fails loudly on any board state the
 * reducer surface cannot replicate exactly (a hidden row with no hide-set
 * membership, or a membership whose target is not hidden).
 */
import { DbConnection } from './module_bindings/index';
import type { Node, Edge } from './module_bindings/types';
import { readTokenAt, saveTokenAt, tokenPathFor } from './identity';

const sourceUri = process.env.SOURCE_URI ?? process.env.SPACETIME_URI;
const sourceDb = process.env.SOURCE_DB ?? process.env.SPACETIME_DB;
if (!sourceUri) throw new Error('SOURCE_URI (or SPACETIME_URI) is not set');
if (!sourceDb) throw new Error('SOURCE_DB (or SPACETIME_DB) is not set');
const targetUri = process.env.TARGET_URI ?? sourceUri;
const targetDb = process.env.TARGET_DB ?? sourceDb;
const sourceTokenPath = tokenPathFor(sourceUri, process.env.SOURCE_TOKEN_FILE ?? process.env.SPACETIME_TOKEN_FILE);
const targetTokenPath = tokenPathFor(targetUri, process.env.TARGET_TOKEN_FILE ??
  (tokenPathFor(targetUri) === tokenPathFor(sourceUri) ? sourceTokenPath : undefined));

const args = process.argv.slice(2);
function argValue(flag: string): string {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) {
    throw new Error(`missing required argument ${flag} <value>`);
  }
  return args[i + 1];
}
const sourceBoardName = argValue('--board');
const targetBoardName = argValue('--to');

function fail(reason: string): never {
  console.error(`FATAL: ${reason}`);
  process.exit(1);
}

function connect(uri: string, db: string, tokenPath: string): Promise<DbConnection> {
  const savedToken = readTokenAt(tokenPath);
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(db)
      .withToken(savedToken)
      .onConnect((conn: DbConnection, _identity, token) => {
        try {
          saveTokenAt(tokenPath, token, savedToken);
        } catch (error) {
          conn.disconnect();
          reject(error);
          return;
        }
        conn.subscriptionBuilder()
          .onApplied(() => resolve(conn))
          .onError(ctx => reject(new Error(`subscription error on ${uri}/${db}: ${String(ctx.event)}`)))
          .subscribeToAllTables();
      })
      .onConnectError((_ctx, err) => reject(new Error(`connection to ${uri}/${db} failed: ${String(err)}`)))
      .build();
  });
}

const byId = <T extends { id: bigint }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

interface Snapshot {
  nodes: Node[];
  edges: Edge[];
  hideSets: { id: bigint; name: string }[];
  members: { id: bigint; setId: bigint; targetKind: string; targetId: bigint }[];
  repoPaths: string[];
  /** Library icon by node id (visible_node_icon). */
  icons: Map<bigint, string>;
}

function snapshot(conn: DbConnection, boardId: bigint): Snapshot {
  const nodes = byId([...conn.db.visibleNode.iter()].filter(n => n.boardId === boardId));
  const edges = byId([...conn.db.visibleEdge.iter()].filter(e => e.boardId === boardId));
  const hideSets = byId([...conn.db.visibleHideSet.iter()].filter(h => h.boardId === boardId));
  const setIds = new Set(hideSets.map(h => h.id));
  const members = byId([...conn.db.visibleHideSetMember.iter()].filter(m => setIds.has(m.setId)));
  // A reader who is not a board member sees no visible_repo_file rows, only the paths its source:
  // edges already cite; registering those is enough for the citations to replay.
  const cited = edges.filter(e => e.evidence.startsWith('source:'))
    .map(e => e.evidence.slice('source:'.length, e.evidence.lastIndexOf(':')));
  const listed = [...conn.db.visibleRepoFile.iter()].filter(f => f.boardId === boardId).map(f => f.path);
  const repoPaths = [...new Set([...listed, ...cited])].sort();
  const icons = new Map([...conn.db.visibleNodeIcon.iter()].filter(i => i.boardId === boardId).map(i => [i.nodeId, i.icon]));
  return { nodes, edges, hideSets, members, repoPaths, icons };
}

/** States the reducer surface cannot reproduce exactly — refuse up front. */
function auditReplicable(s: Snapshot): void {
  // ponytail: chart rows are not copied (create_node refuses kind 'chart');
  // copy them through create_chart when a shared board needs charts.
  const charts = s.nodes.filter(n => n.kind === 'chart').length;
  if (charts > 0) {
    fail(`${charts} chart node(s) on this board; fork-board does not copy chart data yet, so nothing was written`);
  }
  const memberKeys = new Set(s.members.map(m => `${m.targetKind}:${m.targetId}`));
  for (const n of s.nodes) {
    if (n.hidden && !memberKeys.has(`node:${n.id}`)) {
      fail(`node ${n.id} ("${n.label}") is hidden but has no hide-set membership; reducers cannot replicate that state`);
    }
  }
  for (const e of s.edges) {
    if (e.hidden && !memberKeys.has(`edge:${e.id}`)) {
      fail(`edge ${e.id} is hidden but has no hide-set membership; reducers cannot replicate that state`);
    }
  }
  const nodeHidden = new Map(s.nodes.map(n => [n.id, n.hidden]));
  const edgeHidden = new Map(s.edges.map(e => [e.id, e.hidden]));
  for (const m of s.members) {
    const hidden = m.targetKind === 'node' ? nodeHidden.get(m.targetId) : edgeHidden.get(m.targetId);
    if (hidden !== true) {
      fail(`hide-set member ${m.id} targets ${m.targetKind} ${m.targetId} which is not hidden (or not on this board); reducers cannot replicate that state`);
    }
  }
}

async function run(): Promise<void> {
  console.log(`source: ${sourceUri}/${sourceDb}  board "${sourceBoardName}"`);
  console.log(`target: ${targetUri}/${targetDb}  board "${targetBoardName}"`);

  const source = await connect(sourceUri!, sourceDb!, sourceTokenPath);
  const sameInstance = targetUri === sourceUri && targetDb === sourceDb && targetTokenPath === sourceTokenPath;
  const target = sameInstance ? source : await connect(targetUri, targetDb, targetTokenPath);

  const sourceBoard = [...source.db.visibleBoard.iter()].find(b => b.name === sourceBoardName);
  if (!sourceBoard) fail(`board "${sourceBoardName}" not found on source`);
  if ([...target.db.visibleBoard.iter()].some(b => b.name === targetBoardName)) {
    fail(`board "${targetBoardName}" already exists on target -- pick another name`);
  }

  const src = snapshot(source, sourceBoard.id);
  console.log(
    `copying ${src.nodes.length} nodes, ${src.edges.length} edges, ` +
    `${src.hideSets.length} hide sets, ${src.members.length} memberships, ` +
    `${src.repoPaths.length} repo files`
  );
  auditReplicable(src);

  await target.reducers.createBoard({ name: targetBoardName });
  const board = [...target.db.visibleBoard.iter()].find(b => b.name === targetBoardName);
  if (!board) fail('board row not visible after create_board committed');
  const boardId = board.id;

  // repo files first: edge evidence "source:<path>:<line>" validates against them
  const CHUNK = 200;
  for (let i = 0; i < src.repoPaths.length; i += CHUNK) {
    await target.reducers.addRepoFiles({ boardId, paths: src.repoPaths.slice(i, i + CHUNK) });
  }

  // nodes, in source id order; new id = the row on the new board we have not
  // seen yet (positions can collide, ids cannot)
  const nodeIdMap = new Map<bigint, bigint>();
  const seenNodes = new Set<bigint>();
  for (const n of src.nodes) {
    const fields = {
      boardId,
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
    };
    // A node with a library icon is made with it, in one transaction.
    const icon = src.icons.get(n.id);
    await (icon === undefined ? target.reducers.createNode(fields) : target.reducers.createIconNode({ ...fields, icon }));
    const created = [...target.db.visibleNode.iter()].find(r => r.boardId === boardId && !seenNodes.has(r.id));
    if (!created) fail(`created node for source node ${n.id} not visible in cache`);
    seenNodes.add(created.id);
    nodeIdMap.set(n.id, created.id);
  }

  // edges, in source id order, endpoints remapped. create_edge rejects empty
  // evidence, so legacy ''-evidence rows fork as an explicit human assertion —
  // that class change is reported, not hidden.
  const FORK_EVIDENCE = `human:fork:${sourceBoardName}`;
  const normEvidence = (evidence: string) => (evidence.length > 0 ? evidence : FORK_EVIDENCE);
  const legacyEdges = src.edges.filter(e => e.evidence.length === 0).length;
  if (legacyEdges > 0) {
    console.log(
      `${legacyEdges} edge(s) carry empty legacy evidence; forking them as "${FORK_EVIDENCE}"`
    );
  }
  const edgeIdMap = new Map<bigint, bigint>();
  const seenEdges = new Set<bigint>();
  for (const e of src.edges) {
    const fromNode = nodeIdMap.get(e.fromNode);
    const toNode = nodeIdMap.get(e.toNode);
    if (fromNode === undefined || toNode === undefined) {
      fail(`edge ${e.id} references a node outside board "${sourceBoardName}"`);
    }
    await target.reducers.createEdge({
      boardId,
      fromNode,
      toNode,
      label: e.label,
      evidence: normEvidence(e.evidence),
      imported: e.imported,
    });
    const created = [...target.db.visibleEdge.iter()].find(r => r.boardId === boardId && !seenEdges.has(r.id));
    if (!created) fail(`created edge for source edge ${e.id} not visible in cache`);
    seenEdges.add(created.id);
    edgeIdMap.set(e.id, created.id);
  }

  // hide sets, in source id order. resolveHideSet only creates a set on
  // demand, so materialize each one with a hide/unhide toggle on the first
  // node (unhide clears the membership again; real memberships come next).
  if (src.hideSets.length > 0 && src.nodes.length === 0) {
    fail('source board has hide sets but no nodes; cannot materialize sets through reducers');
  }
  const probeNodeId = nodeIdMap.get(src.nodes[0]?.id!);
  for (const hs of src.hideSets) {
    await target.reducers.setNodeHidden({ nodeId: probeNodeId!, hidden: true, setName: hs.name });
    await target.reducers.setNodeHidden({ nodeId: probeNodeId!, hidden: false, setName: undefined });
  }

  // memberships, in source id order; setXHidden also flips the hidden flag,
  // which the audit proved is true for every membership target
  const setNameById = new Map(src.hideSets.map(h => [h.id, h.name]));
  for (const m of src.members) {
    const setName = setNameById.get(m.setId)!;
    if (m.targetKind === 'node') {
      await target.reducers.setNodeHidden({ nodeId: nodeIdMap.get(m.targetId)!, hidden: true, setName });
    } else if (m.targetKind === 'edge') {
      await target.reducers.setEdgeHidden({ edgeId: edgeIdMap.get(m.targetId)!, hidden: true, setName });
    } else {
      fail(`membership ${m.id} has unknown targetKind "${m.targetKind}"`);
    }
  }

  // ---- verify: field-by-field against the source snapshot ----
  const copy = snapshot(target, boardId);
  const errors: string[] = [];
  const check = (what: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      errors.push(`${what}: source=${JSON.stringify(a)} copy=${JSON.stringify(b)}`);
    }
  };

  check('node count', src.nodes.length, copy.nodes.length);
  check('edge count', src.edges.length, copy.edges.length);
  check('hide set count', src.hideSets.length, copy.hideSets.length);
  check('membership count', src.members.length, copy.members.length);
  check('repo file count', src.repoPaths.length, copy.repoPaths.length);

  const nodeKey = (n: Node, s: Snapshot) =>
    [n.label, n.sublabel, n.x, n.y, n.w, n.h, n.token, n.focal, n.kind, n.doc, n.hidden, n.imported, s.icons.get(n.id) ?? ''].join('\0');
  for (let i = 0; i < Math.min(src.nodes.length, copy.nodes.length); i++) {
    check(`node[${i}]`, nodeKey(src.nodes[i], src), nodeKey(copy.nodes[i], copy));
  }
  const srcNodeIndex = new Map(src.nodes.map((n, i) => [n.id, i]));
  const copyNodeIndex = new Map(copy.nodes.map((n, i) => [n.id, i]));
  const edgeKey = (e: Edge, index: Map<bigint, number>) =>
    [index.get(e.fromNode), index.get(e.toNode), e.label, normEvidence(e.evidence), e.hidden, e.imported].join('\0');
  for (let i = 0; i < Math.min(src.edges.length, copy.edges.length); i++) {
    check(`edge[${i}]`, edgeKey(src.edges[i], srcNodeIndex), edgeKey(copy.edges[i], copyNodeIndex));
  }
  check('hide set names', src.hideSets.map(h => h.name), copy.hideSets.map(h => h.name));
  const srcSetIndex = new Map(src.hideSets.map((h, i) => [h.id, i]));
  const copySetIndex = new Map(copy.hideSets.map((h, i) => [h.id, i]));
  const srcEdgeIndex = new Map(src.edges.map((e, i) => [e.id, i]));
  const copyEdgeIndex = new Map(copy.edges.map((e, i) => [e.id, i]));
  const memberKeys = (
    s: Snapshot,
    setIndex: Map<bigint, number>,
    nIndex: Map<bigint, number>,
    eIndex: Map<bigint, number>
  ) =>
    s.members
      .map(m => `${setIndex.get(m.setId)}:${m.targetKind}:${m.targetKind === 'node' ? nIndex.get(m.targetId) : eIndex.get(m.targetId)}`)
      .sort();
  check(
    'memberships',
    memberKeys(src, srcSetIndex, srcNodeIndex, srcEdgeIndex),
    memberKeys(copy, copySetIndex, copyNodeIndex, copyEdgeIndex)
  );
  check('repo files', src.repoPaths, copy.repoPaths);

  if (errors.length > 0) {
    for (const e of errors) console.error(`MISMATCH ${e}`);
    fail(`copy differs from source in ${errors.length} place(s)`);
  }

  console.log(
    `forked "${sourceBoardName}" -> "${targetBoardName}" (board id ${boardId}): ` +
    `${copy.nodes.length} nodes, ${copy.edges.length} edges, ${copy.hideSets.length} hide sets, ` +
    `${copy.members.length} memberships, ${copy.repoPaths.length} repo files -- verified identical`
  );
  target.disconnect();
  if (!sameInstance) source.disconnect();
  setTimeout(() => process.exit(0), 300);
}

run().catch(err => fail(String((err as Error).stack ?? err)));
