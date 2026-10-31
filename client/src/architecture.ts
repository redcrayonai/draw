import { edgeKey, graphDiff, type Graph } from '../../module/src/architecture';
import type { Node, Edge } from './module_bindings/types';

export interface Version {
  boardId: bigint; historyId: bigint; index: number; assertionMode: string;
  baseBoardId: bigint; ref: string; sha: string; status: string; requestKey: string;
  reviewedSignature: string; implementedBoardId: bigint;
}
export type DiffStatus = 'added' | 'removed' | 'changed';

export function orderedSnapshots(versions: Iterable<Version>, historyId: bigint): Version[] {
  return [...versions].filter(v => v.historyId === historyId && v.assertionMode === 'fact')
    .sort((a, b) => a.index - b.index);
}

export function comparisonBoard(version: Version, versions: Iterable<Version>): bigint | null {
  if (version.assertionMode === 'intent') return version.baseBoardId;
  const snapshots = orderedSnapshots(versions, version.historyId);
  const index = snapshots.findIndex(v => v.boardId === version.boardId);
  return index > 0 ? snapshots[index - 1].boardId : null;
}

interface RepositoryHistory { id: bigint; repository: string; createdAt: { microsSinceUnixEpoch: bigint } }
const canonicalRepository = (repository: string) => repository.toLowerCase().replace(/\/$/, '').replace(/\.git$/, '');
export function reconciliationSnapshot(proposal: Version, versions: Iterable<Version>, histories: Iterable<RepositoryHistory>): Version | undefined {
  const byId = new Map([...histories].map(h => [h.id, h]));
  const baseHistory = byId.get(proposal.historyId);
  if (!baseHistory) return;
  return [...versions].filter(v => v.assertionMode === 'fact' && v.sha !== proposal.sha &&
    byId.has(v.historyId) && canonicalRepository(byId.get(v.historyId)!.repository) === canonicalRepository(baseHistory.repository) &&
    (v.historyId === proposal.historyId ? v.index > proposal.index : byId.get(v.historyId)!.createdAt.microsSinceUnixEpoch >= baseHistory.createdAt.microsSinceUnixEpoch))
    .sort((a, b) => {
      const left = byId.get(a.historyId)!.createdAt.microsSinceUnixEpoch;
      const right = byId.get(b.historyId)!.createdAt.microsSinceUnixEpoch;
      return left === right ? b.index - a.index : left > right ? -1 : 1;
    })[0];
}

const sourceKey = (node: Node) => node.sourceKey || `legacy:${node.id}`;
/**
 * Charts never enter the graph (the module skips them too). On a hand-drawn
 * base (`sinceFork`), rows without a key or relation were added after the fork
 * backfilled identity, so they are not "removed" by the branch.
 * shortcut: a row keyed by a later fork still shows as removed; upgrade when the
 * fork-time key set reaches the client.
 */
function graph(nodes: Node[], edges: Edge[], sinceFork = false): Graph {
  nodes = nodes.filter(n => n.kind !== 'chart' && !(sinceFork && n.sourceKey === ''));
  const keys = new Map(nodes.map(n => [n.id, sourceKey(n)]));
  edges = edges.filter(e => !(sinceFork && e.relation === ''));
  return {
    nodes: nodes.map(n => ({ key: sourceKey(n), label: n.label, sublabel: n.sublabel, kind: n.kind })),
    edges: edges.filter(e => keys.has(e.fromNode) && keys.has(e.toNode)).map(e => ({
      from: keys.get(e.fromNode)!, to: keys.get(e.toNode)!, relation: e.relation,
      label: e.label, evidence: e.evidence,
    })), files: [],
  };
}

/** Removed rows use negative IDs and are only passed to the renderer. */
/** `content`: a hand-drawn base has no importer meaning, so label, sublabel, doc and edge label edits count as changes too. */
export function diffScene(baseNodes: Node[], baseEdges: Edge[], nodes: Node[], edges: Edge[], opts: { content?: boolean } = {}) {
  const before = graph(baseNodes, baseEdges, opts.content), after = graph(nodes, edges);
  const diff = graphDiff(before, after);
  const nodeDiff = new Map<bigint, DiffStatus>(), edgeDiff = new Map<bigint, DiffStatus>();
  const addedNodes = new Set(diff.addedNodes), changedNodes = new Set(diff.changedNodes);
  const addedEdges = new Set(diff.addedEdges), changedEdges = new Set(diff.changedEdges);
  const removedNodes = new Set(diff.removedNodes), removedEdges = new Set(diff.removedEdges);
  const currentIds = new Map(nodes.map(n => [sourceKey(n), n.id]));
  const baseKeys = new Map(baseNodes.map(n => [n.id, sourceKey(n)]));
  const currentKeys = new Map(nodes.map(n => [n.id, sourceKey(n)]));
  const keyOf = (e: Edge, keys: Map<bigint, string>) => edgeKey(keys.get(e.fromNode)!, keys.get(e.toNode)!, e.relation);
  for (const n of nodes) {
    if (addedNodes.has(sourceKey(n))) nodeDiff.set(n.id, 'added');
    else if (changedNodes.has(sourceKey(n))) nodeDiff.set(n.id, 'changed');
  }
  for (const e of edges) {
    if (addedEdges.has(keyOf(e, currentKeys))) edgeDiff.set(e.id, 'added');
    else if (changedEdges.has(keyOf(e, currentKeys))) edgeDiff.set(e.id, 'changed');
  }
  if (opts.content) {
    const baseByKey = new Map(baseNodes.map(n => [sourceKey(n), n]));
    for (const n of nodes) {
      const b = baseByKey.get(sourceKey(n));
      if (b && !nodeDiff.has(n.id) && (b.label !== n.label || b.sublabel !== n.sublabel || b.doc !== n.doc)) nodeDiff.set(n.id, 'changed');
    }
    const baseEdgeByKey = new Map(baseEdges.map(e => [keyOf(e, baseKeys), e]));
    for (const e of edges) {
      const b = baseEdgeByKey.get(keyOf(e, currentKeys));
      if (b && !edgeDiff.has(e.id) && b.label !== e.label) edgeDiff.set(e.id, 'changed');
    }
  }
  const missingNodes = baseNodes.filter(n => removedNodes.has(sourceKey(n))).map(n => {
    nodeDiff.set(-n.id, 'removed');
    return { ...n, id: -n.id };
  });
  const missingEdges = baseEdges.filter(e => removedEdges.has(keyOf(e, baseKeys))).map(e => {
    edgeDiff.set(-e.id, 'removed');
    return { ...e, id: -e.id,
      fromNode: currentIds.get(baseKeys.get(e.fromNode)!) ?? -e.fromNode,
      toNode: currentIds.get(baseKeys.get(e.toNode)!) ?? -e.toNode,
    };
  });
  return { nodeDiff, edgeDiff, removedNodes: missingNodes, removedEdges: missingEdges, diff };
}
