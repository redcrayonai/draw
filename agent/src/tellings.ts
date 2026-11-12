/** Telling tools: the input shapes, reducer arguments and tool texts of the hosted MCP server (mcp/src/tools.ts). */
import { z } from 'zod';
import { MAX_AUDIENCE, MAX_STEP_BODY, MAX_STEP_NODES, MAX_STEP_SOURCE, MAX_STEP_TITLE, MAX_TELLING_STEPS, MAX_TELLING_TITLE } from '../../module/src/tellings';

const id = z.string().regex(/^\d+$/).describe('numeric id as a string');

const step = z
  .object({
    nodes: z.array(id).min(1).max(MAX_STEP_NODES),
    frame: z.array(id).max(MAX_STEP_NODES).optional(),
    title: z.string().min(1).max(MAX_STEP_TITLE),
    body: z.string().min(1).max(MAX_STEP_BODY),
    source: z.string().max(MAX_STEP_SOURCE).optional(),
  })
  .strict();

export const tellingInput = {
  audience: z.string().min(1).max(MAX_AUDIENCE).describe('who this walk-through is for, e.g. "Product"'),
  title: z.string().min(1).max(MAX_TELLING_TITLE),
  steps: z.array(step).min(1).max(MAX_TELLING_STEPS),
  author: z.string().optional(),
};

export type TellingInput = z.infer<z.ZodObject<typeof tellingInput>>;

/** Shapes only: the module is the authority on every rule. */
export function saveTellingArgs(boardId: bigint, input: TellingInput, author: string) {
  const steps = input.steps.map(s => ({ nodes: s.nodes, frame: s.frame ?? [], title: s.title, body: s.body, source: s.source ?? '' }));
  return { boardId, audience: input.audience, title: input.title, steps: JSON.stringify(steps), author };
}

export const SAVE_TELLING_DESCRIPTION =
  'Save a walk-through of this board for one audience: ordered steps, each lighting 1 to 12 nodes with a short title and one sentence (body), and optionally where the claim comes from (source) and which nodes the view should frame (frame). Start from one node the audience already knows and add a few nodes per step. Saving again for the same audience replaces it. At most 12 steps and 6 audiences per board.';
export const REMOVE_TELLING_DESCRIPTION = "Remove this board's walk-through for one audience.";
