/** Public visual projection. IDs are strings because the wire payload is JSON.
 * Never add docs, code references, identities or source evidence here. */
export interface EmbedNode {
  id: string; key: string; label: string; sublabel: string;
  x: number; y: number; w: number; h: number; token: string; focal: boolean;
  kind: string; shape: string; color: string; strokeStyle: string; size: string; icon?: string;
}
export interface EmbedEdge {
  id: string; fromNode: string; toNode: string; label: string;
  color: string; strokeStyle: string; relation: string; latencyMs: number; weight?: string;
}
export interface EmbedChart {
  nodeId: string; type: string; csv: string; options: string; source: string; updatedAt: string;
}
export interface EmbedGraph { nodes: EmbedNode[]; edges: EmbedEdge[]; charts: EmbedChart[] }
export interface EmbedScene extends EmbedGraph {
  route: string[];
  threats: { id: string; anchorId: string; title: string; stage: string; severity: string }[];
  before: EmbedGraph | null;
}
