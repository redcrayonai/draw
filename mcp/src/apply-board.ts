import { z } from 'zod';
import { errorResult, okResult, type ToolResult } from './scrub';

const MAX_OPERATIONS = 16;
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/);
const endpoint = z.string().regex(/^(?:\d+|\$[A-Za-z][A-Za-z0-9_-]{0,39})$/);

export function applyBoardInput(node: z.ZodObject, edge: z.ZodObject) {
  return z.object({
    board: node.shape.board,
    nodes: z.array(node.omit({ board: true }).extend({ key })).max(MAX_OPERATIONS).default([]),
    edges: z.array(edge.omit({ board: true }).extend({ fromNode: endpoint, toNode: endpoint })).max(MAX_OPERATIONS).default([]),
    layout: z.boolean().default(false),
  }).strict().superRefine((args, ctx) => {
    const count = args.nodes.length + args.edges.length + Number(args.layout);
    if (count < 1 || count > MAX_OPERATIONS) ctx.addIssue({ code: 'custom', message: `REJECTED: pass 1-${MAX_OPERATIONS} operations, counting layout.` });
    const keys = new Set<string>();
    for (const n of args.nodes) {
      const name = n.key as string;
      if (keys.has(name)) ctx.addIssue({ code: 'custom', message: 'REJECTED: node keys must be unique.' });
      keys.add(name);
    }
    for (const e of args.edges) {
      for (const id of [e.fromNode, e.toNode] as string[]) {
        if (id.startsWith('$') && !keys.has(id.slice(1))) ctx.addIssue({ code: 'custom', message: 'REJECTED: an edge names an unknown node key.' });
      }
      if (typeof e.evidence === 'string' && e.evidence.startsWith('source:') && !e.capture) {
        ctx.addIssue({ code: 'custom', message: 'REJECTED: each source edge needs its own capture. Run npx -y @redcrayonai/draw@1 capture cite <path> --board <board> and pass its id as capture on that edge.' });
      }
    }
  });
}

type Args = {
  board: string;
  nodes: ({ key: string } & Record<string, unknown>)[];
  edges: ({ fromNode: string; toNode: string } & Record<string, unknown>)[];
  layout: boolean;
};
type Call = (name: 'create_node' | 'create_edge' | 'layout_board', args: Record<string, unknown>) => Promise<ToolResult>;

/** Each wave settles before the next starts, including after a failure. */
export async function applyBoard(args: Args, call: Call, deadline: number): Promise<ToolResult> {
  const nodes: Record<string, string> = {};
  const edges: string[] = [];
  const results: { tool: string; key?: string; text: string }[] = [];
  let error: string | undefined;
  const resolve = (id: string) => id.startsWith('$') ? nodes[id.slice(1)] : id;
  const run = async (tool: Parameters<Call>[0], input: Record<string, unknown>, key?: string) => {
    // Layout needs its 5 s write budget and 1 s response margin to finish a container as one unit.
    if (tool === 'layout_board' && Date.now() >= deadline - 6_000) {
      error = 'UNAVAILABLE: the batch has too little time left for layout. Call layout_board to finish.';
      return;
    }
    const result = await call(tool, { board: args.board, ...input });
    const text = result.content.map(c => c.text).join('\n');
    results.push({ tool, ...(key === undefined ? {} : { key }), text });
    if (result.isError) { error ??= text; return; }
    if (tool === 'layout_board') {
      if (text.includes('; call again to continue')) error ??= 'UNAVAILABLE: layout has more moves to apply. Call layout_board to continue.';
      return;
    }
    const id = /^committed id=(\d+)\b/.exec(text)?.[1];
    if (id === undefined) {
      error ??= 'UNCONFIRMED: a create committed without an unambiguous id. Call get_board before any retry.';
    } else if (key !== undefined) nodes[key] = id;
    else edges.push(id);
  };
  const stages = [
    args.nodes.map(({ key, ...input }) => () => run('create_node', input, key)),
    args.edges.map(input => () => run('create_edge', { ...input, fromNode: resolve(input.fromNode), toNode: resolve(input.toNode) })),
    args.layout ? [() => run('layout_board', {})] : [],
  ];
  for (const stage of stages) {
    for (let i = 0; i < stage.length && !error; i += 3) {
      if (Date.now() >= deadline) {
        error = 'UNCONFIRMED: the batch time budget ended. Call get_board before any retry.';
        break;
      }
      await Promise.all(stage.slice(i, i + 3).map(run => run()));
    }
    if (error) break;
  }
  const summary = { complete: error === undefined, nodes, edges, results };
  const text = JSON.stringify(summary);
  return { ...(error ? errorResult(`${error.replace('Nothing was written.', 'That operation wrote nothing.')}\nBatch stopped; earlier operations may have committed. Inspect these results and call get_board before any retry.\n${text}`) : okResult(text)), structuredContent: summary };
}
