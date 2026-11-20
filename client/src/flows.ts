// Flows: a telling with a colour (set_telling_color). Pure: what the legend lists and what the board paints.
import { stepView, type Telling } from './telling';

export interface Flow {
  id: bigint; name: string; title: string; color: string; steps: number;
  nodes: ReadonlySet<bigint>;
  /** node -> the 1-based step that first names it */
  stepOf: ReadonlyMap<bigint, number>;
}

/** The board's flows, oldest first: every telling that has a colour, with the nodes still on the board. */
export function readFlows(tellings: readonly Telling[], live: ReadonlySet<bigint>): Flow[] {
  return tellings.filter(t => t.color !== '').map(t => {
    const { stepOf } = stepView(t, t.steps.length, live); // the ending: every named node
    return { id: t.id, name: t.audience, title: t.title, color: t.color, steps: t.steps.length, nodes: new Set(stepOf.keys()), stepOf };
  });
}

export interface FlowPaint {
  /** The hue a node or edge without a colour of its own takes. */
  nodeHue: ReadonlyMap<bigint, string>;
  edgeHue: ReadonlyMap<bigint, string>;
  /** Nodes more than one flow passes through: one hue per flow. Empty while one flow is shown alone. */
  dots: ReadonlyMap<bigint, readonly string[]>;
  /** One flow shown alone: its nodes (the rest of the board dims) and their step numbers. */
  only: ReadonlySet<bigint> | null;
  stepOf: ReadonlyMap<bigint, number> | null;
}

/**
 * With no flow picked, a node only one flow uses takes its hue and a shared node gets a dot per flow.
 * With one picked, all of its nodes take its hue, shared ones too. An edge belongs to a flow when both its ends do.
 */
export function flowPaint(flows: readonly Flow[], edges: readonly { id: bigint; fromNode: bigint; toNode: bigint }[], picked: bigint | null): FlowPaint | null {
  if (flows.length === 0) return null;
  const one = picked === null ? undefined : flows.find(f => f.id === picked);
  const shown = one ? [one] : flows;
  const through = new Map<bigint, Flow[]>();
  for (const f of shown) for (const id of f.nodes) through.set(id, [...(through.get(id) ?? []), f]);
  const nodeHue = new Map<bigint, string>(), dots = new Map<bigint, string[]>(), edgeHue = new Map<bigint, string>();
  for (const [id, fs] of through) {
    if (fs.length === 1) nodeHue.set(id, fs[0].color);
    else dots.set(id, fs.map(f => f.color));
  }
  for (const e of edges) {
    const both = (through.get(e.fromNode) ?? []).filter(f => f.nodes.has(e.toNode));
    if (both.length === 1) edgeHue.set(e.id, both[0].color);
  }
  return { nodeHue, edgeHue, dots, only: one ? one.nodes : null, stepOf: one ? one.stepOf : null };
}
