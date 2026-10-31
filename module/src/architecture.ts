export type Graph = {
  nodes: { key: string; label: string; sublabel: string; kind: string }[];
  edges: { from: string; to: string; label: string; relation: string; evidence: string }[];
  files: string[];
};

const KINDS = ['service', 'datastore', 'external', 'boundary', 'note'];
export const edgeKey = (from: string, to: string, relation: string): string => JSON.stringify([from, to, relation]);

function text(value: unknown, field: string, nonempty = false): string {
  if (typeof value !== 'string' || value.length > 4000 || (nonempty && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`graph ${field} must be ${nonempty ? 'a nonempty ' : 'a '}string of at most 4000 characters without control characters`);
  }
  return value;
}

export function validateGraph(raw: unknown): Graph {
  const g = raw as Graph;
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges) || !Array.isArray(g.files)) throw new Error('graph must contain nodes, edges and files arrays');
  if (g.nodes.length > 5000 || g.edges.length > 20000 || g.files.length > 100000) throw new Error('graph exceeds limit (5000 nodes, 20000 edges, 100000 files)');
  const keys = new Set<string>();
  const nodes = g.nodes.map(n => {
    if (!n || typeof n !== 'object') throw new Error('graph node must be an object');
    const key = text(n.key, 'node key', true);
    if (keys.has(key)) throw new Error(`duplicate graph node key ${key}`);
    keys.add(key);
    if (!KINDS.includes(n.kind)) throw new Error(`graph node kind ${n.kind} is invalid`);
    return { key, label: text(n.label, 'node label'), sublabel: text(n.sublabel, 'node sublabel'), kind: n.kind };
  });
  const identities = new Set<string>();
  const files = [...new Set(g.files.map(f => {
    const path = text(f, 'file path', true);
    if (path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')) throw new Error('graph file path must be relative');
    return path;
  }))].sort();
  const fileSet = new Set(files);
  const edges = g.edges.map(e => {
    if (!e || typeof e !== 'object') throw new Error('graph edge must be an object');
    const from = text(e.from, 'edge from', true), to = text(e.to, 'edge to', true), relation = text(e.relation, 'edge relation');
    if (!keys.has(from) || !keys.has(to)) throw new Error('graph edge endpoint does not exist');
    const identity = edgeKey(from, to, relation);
    if (identities.has(identity)) throw new Error(`duplicate graph edge ${identity}`);
    identities.add(identity);
    const evidence = text(e.evidence, 'edge evidence');
    if (evidence !== '' && evidence !== 'import' && evidence !== 'test-import' && !/^human:.+/.test(evidence) && !/^agent:.+/.test(evidence)) {
      const match = /^source:(.+):([1-9][0-9]*)$/.exec(evidence);
      if (!match || !fileSet.has(match[1])) throw new Error('graph edge evidence is invalid or references a missing file');
    }
    return { from, to, relation, label: text(e.label, 'edge label'), evidence };
  });
  return { nodes, edges, files };
}

const nodeMeaning = (n: Graph['nodes'][number]) => n.kind;
const edgeMeaning = (e: Graph['edges'][number]) => e.evidence;
const nodesByKey = (g: Graph) => new Map(g.nodes.map(n => [n.key, n]));
const edgesByKey = (g: Graph) => new Map(g.edges.map(e => [edgeKey(e.from, e.to, e.relation), e]));

export function graphDiff(base: Graph, head: Graph) {
  const bn = nodesByKey(base), hn = nodesByKey(head), be = edgesByKey(base), he = edgesByKey(head);
  return {
    addedNodes: [...hn.keys()].filter(k => !bn.has(k)).sort(),
    removedNodes: [...bn.keys()].filter(k => !hn.has(k)).sort(),
    changedNodes: [...hn.keys()].filter(k => bn.has(k) && nodeMeaning(bn.get(k)!) !== nodeMeaning(hn.get(k)!)).sort(),
    addedEdges: [...he.keys()].filter(k => !be.has(k)).sort(),
    removedEdges: [...be.keys()].filter(k => !he.has(k)).sort(),
    changedEdges: [...he.keys()].filter(k => be.has(k) && edgeMeaning(be.get(k)!) !== edgeMeaning(he.get(k)!)).sort(),
  };
}

// Labels and layout are presentation. Reality only has to contain the
// proposal's delta; source imports may supply evidence for an unevidenced intent.
export function proposalSatisfied(base: Graph, intent: Graph, reality: Graph): boolean {
  const d = graphDiff(base, intent), rn = nodesByKey(reality), re = edgesByKey(reality), ni = nodesByKey(intent), ei = edgesByKey(intent);
  if (d.addedNodes.some(k => k.startsWith('proposal:'))) return false;
  if (d.removedNodes.some(k => rn.has(k)) || d.removedEdges.some(k => re.has(k))) return false;
  if ([...d.addedNodes, ...d.changedNodes].some(k => !rn.has(k) || nodeMeaning(rn.get(k)!) !== nodeMeaning(ni.get(k)!))) return false;
  return ![...d.addedEdges, ...d.changedEdges].some(k => !re.has(k) || (ei.get(k)!.evidence !== '' && edgeMeaning(re.get(k)!) !== edgeMeaning(ei.get(k)!)));
}

export function graphSignature(graph: Graph): string {
  const byKey = (a: string[], b: string[]) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  return JSON.stringify({ nodes: graph.nodes.map(n => [n.key, n.kind]).sort(byKey), edges: graph.edges.map(e => [edgeKey(e.from, e.to, e.relation), e.evidence]).sort(byKey) });
}
