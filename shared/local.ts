/** Local wire/storage contract. IDs are strings, including across browser and tools. */
export const LOCAL_REQUEST_BYTES = 1024 * 1024;
export type LocalRef = { path: string; start: number; end: number };
/** The icons a local board offers: the unbranded Agents and Systems sections of module/src/node-icons.ts,
 *  so no product or company marks. client/src/local-icons.test.ts keeps the list in step with the registry. */
export const LOCAL_ICONS: readonly string[] = ['agent', 'orchestrator', 'subagent', 'model', 'tool', 'mcp-server', 'memory', 'knowledge-base', 'prompt', 'human', 'guardrail', 'evaluator', 'queue', 'cache', 'scheduler', 'event', 'gateway', 'function', 'browser', 'sandbox'];
export type LocalNode = { id: string; label: string; description: string; x: number; y: number; w: number; h: number; kind: 'service' | 'datastore' | 'external' | 'boundary' | 'note' | 'text'; refs: LocalRef[]; icon?: string; color?: string };
export type LocalEdge = { id: string; from: string; to: string; label: string; description: string; direction: 'forward' | 'both' | 'none'; refs: LocalRef[]; color?: string };
export type LocalNote = { id: string; target: string; text: string; resolved: boolean; replies: { id: string; text: string }[] };
export type LocalFeedback = { id: string; text: string; context: string; state: 'saved' | 'pending' | 'delivered' | 'uncertain' | 'answered'; reply: string };
export type LocalBoard = { slug: string; name: string; repo: string; revision: number; nextId: number; nodes: LocalNode[]; edges: LocalEdge[]; notes: LocalNote[]; feedback: LocalFeedback[]; conversation?: { threadId: string; socketPath?: string; agent?: 'codex' | 'claude-code' | 'pi' } };
export type LocalOperation =
  | { type: 'graph.restore'; nodes: LocalNode[]; edges: LocalEdge[] }
  | { type: 'node.put'; id?: string; patch: Partial<Omit<LocalNode, 'id'>> }
  | { type: 'edge.put'; id?: string; patch: Partial<Omit<LocalEdge, 'id'>> }
  | { type: 'element.delete'; id: string }
  | { type: 'note.add'; target: string; text: string }
  | { type: 'note.reply'; id: string; text: string }
  | { type: 'note.resolve'; id: string; resolved: boolean };
