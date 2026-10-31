// Node icons: the single source of truth for the library's icons and logos (spec 2026-10-18, RC-687).
// Zero imports, erasable TypeScript only, ES2021 APIs only: the module bundle, the client,
// the agent, the hosted MCP and `node --experimental-strip-types` all load this file as is.
// An id is stored in node_icon.icon and is never renamed. The drawings live in the client
// (client/src/node-icons.ts), keyed by these ids.

export type IconSection = 'agents' | 'systems' | 'ai' | 'cloud';
/** The kinds an icon node may have; boundary takes an icon beside its label. */
export type IconKind = 'service' | 'datastore' | 'external';

export interface IconSpec {
  id: string;
  section: IconSection;
  /** Tile label, and the label a placed node starts with. */
  name: string;
  /** The kind a placed node starts with; the person or agent can change it. */
  kind: IconKind;
  /** Extra search words; the name, the id and the section title match too. */
  terms: readonly string[];
}

export const ICON_SECTIONS: ReadonlyArray<{ id: IconSection; title: string }> = [
  { id: 'agents', title: 'Agents' },
  { id: 'systems', title: 'Systems' },
  { id: 'ai', title: 'AI logos' },
  { id: 'cloud', title: 'Cloud logos' },
];

const icon = (section: IconSection, kind: IconKind) => (id: string, name: string, terms: readonly string[]): IconSpec => ({ id, section, name, kind, terms });
const agent = (kind: IconKind) => icon('agents', kind);
const system = (kind: IconKind) => icon('systems', kind);
const ai = icon('ai', 'external');
const cloud = icon('cloud', 'external');

export const ICONS: readonly IconSpec[] = [
  agent('service')('agent', 'Agent', ['ai', 'bot', 'assistant', 'autonomous', 'llm agent']),
  agent('service')('orchestrator', 'Orchestrator', ['planner', 'supervisor', 'coordinator', 'router', 'multi-agent', 'lead agent']),
  agent('service')('subagent', 'Sub-agent', ['subagent', 'worker', 'delegate', 'child agent', 'specialist', 'task agent']),
  agent('external')('model', 'Model', ['llm', 'foundation model', 'inference', 'completion', 'claude', 'gpt', 'gemini']),
  agent('service')('tool', 'Tool', ['function', 'tool call', 'action', 'plugin', 'skill']),
  agent('external')('mcp-server', 'MCP server', ['mcp', 'model context protocol', 'connector', 'integration', 'server', 'plug']),
  agent('datastore')('memory', 'Memory', ['context', 'state', 'history', 'scratchpad', 'long-term memory', 'session']),
  agent('datastore')('knowledge-base', 'Knowledge base', ['rag', 'retrieval', 'vector store', 'embeddings', 'docs', 'index', 'search']),
  agent('datastore')('prompt', 'Prompt', ['system prompt', 'instructions', 'template', 'context file', 'claude.md']),
  agent('external')('human', 'Human', ['user', 'person', 'reviewer', 'approval', 'human in the loop', 'hitl', 'operator']),
  agent('service')('guardrail', 'Guardrail', ['safety', 'policy', 'filter', 'moderation', 'validator', 'permission']),
  agent('service')('evaluator', 'Evaluator', ['eval', 'judge', 'grader', 'scorer', 'benchmark', 'llm as judge']),

  system('datastore')('queue', 'Queue', ['message queue', 'buffer', 'job queue', 'sqs', 'kafka', 'backlog']),
  system('datastore')('cache', 'Cache', ['redis', 'memcached', 'fast', 'kv', 'key value', 'cdn']),
  system('service')('scheduler', 'Scheduler', ['cron', 'timer', 'job', 'schedule', 'clock', 'periodic']),
  system('service')('event', 'Event', ['webhook', 'trigger', 'pubsub', 'topic', 'stream', 'notification', 'event bus']),
  system('service')('gateway', 'Gateway', ['api gateway', 'load balancer', 'proxy', 'router', 'ingress', 'edge']),
  system('service')('function', 'Function', ['serverless', 'lambda', 'worker', 'handler', 'cloud function', 'faas']),
  system('external')('browser', 'Browser', ['client', 'web app', 'frontend', 'ui', 'computer use', 'website']),
  system('service')('sandbox', 'Sandbox', ['code execution', 'interpreter', 'container', 'runtime', 'terminal', 'vm', 'shell']),

  // AI logos follow each brand's own guidelines too (spec D17), drawn from their own files.
  // Claude and Claude Code use the Spark from Anthropic's public press kit (Alan, 2026-10-19).
  // Codex has no official logo; Gemini and the others need written permission first (spec, "AI logos").
  ai('claude', 'Claude', ['anthropic', 'opus', 'sonnet', 'haiku', 'fable', 'model']),
  ai('claude-code', 'Claude Code', ['anthropic', 'cli', 'coding agent']),
  // OpenAI's Marks usage terms accepted by Alan, 2026-10-19.
  ai('openai', 'OpenAI', ['chatgpt', 'gpt', 'model']),
  ai('grok', 'Grok', ['xai', 'x.ai', 'model']),
  ai('mistral', 'Mistral', ['mistral ai', 'le chat', 'codestral', 'model']),
  ai('hugging-face', 'Hugging Face', ['hf', 'transformers', 'hub', 'model']),
  ai('openrouter', 'OpenRouter', ['model router', 'gateway', 'model']),
  ai('cursor', 'Cursor', ['ide', 'editor', 'anysphere', 'coding agent']),
  ai('github-copilot', 'GitHub Copilot', ['copilot', 'github', 'microsoft', 'coding agent']),
  ai('windsurf', 'Windsurf', ['codeium', 'cognition', 'ide', 'coding agent']),
  ai('devin', 'Devin', ['cognition', 'coding agent']),
  ai('openclaw', 'OpenClaw', ['clawdbot', 'moltbot', 'personal assistant', 'lobster', 'agent']),
  ai('hermes-agent', 'Hermes Agent', ['hermes', 'nous research', 'nous', 'agent']),
  ai('opencode', 'OpenCode', ['sst', 'cli', 'coding agent']),

  // Cloud logos follow each provider's brand guidelines (spec D18): only the ones whose
  // published rules allow a diagram tool to show their mark. The others need written
  // permission first (spec, "Cloud logos"). AWS and Azure take the names their rules ask for.
  cloud('aws', 'AWS Cloud', ['aws', 'amazon web services', 'amazon', 'ec2', 's3', 'lambda', 'cloud']),
  cloud('azure', 'Microsoft Azure', ['azure', 'microsoft', 'cloud']),
  cloud('vercel', 'Vercel', ['next.js', 'edge', 'hosting', 'cloud']),
  cloud('supabase', 'Supabase', ['postgres', 'database', 'auth', 'backend']),
  cloud('firebase', 'Firebase', ['google', 'firestore', 'backend']),
  cloud('neon', 'Neon', ['postgres', 'database', 'serverless postgres']),
  cloud('kubernetes', 'Kubernetes', ['k8s', 'cluster', 'container', 'orchestration']),
];

export const ICON_IDS: readonly string[] = ICONS.map(i => i.id);
const BY_ID: Readonly<Record<string, IconSpec>> = Object.fromEntries(ICONS.map(i => [i.id, i]));

export function isIconId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(BY_ID, id);
}

export function iconSpec(id: string): IconSpec | undefined {
  return isIconId(id) ? BY_ID[id] : undefined;
}

/** The kinds that draw an icon; a note is bare text and a chart draws its own card. */
export const ICON_NODE_KINDS: readonly string[] = ['service', 'datastore', 'external', 'boundary'];
export const ICON_KIND_RULE = 'icons go on service, datastore, external and boundary nodes';
export const ARCHITECTURE_ICON_RULE = 'icons are not supported on architecture boards yet';

/** Default size of a placed icon node: the icon above a label, on the 4 px grid. */
export const ICON_NODE_W = 160;
export const ICON_NODE_H = 96;

/** Icon size per node size: 24, 28 or 36 px for s, m and l (spec D7). The client draws
 *  it from ICON_TOP, and the label band starts ICON_GAP below it. */
export function iconPx(size: string): number {
  return size === 's' ? 24 : size === 'l' ? 36 : 28;
}
export const ICON_TOP = 12;
export const ICON_GAP = 6;
/** Where the label band below a node's icon starts. */
export function iconTextTop(size: string): number {
  return ICON_TOP + iconPx(size) + ICON_GAP;
}
