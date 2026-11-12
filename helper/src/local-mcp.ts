import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { once } from 'node:events';
import { localDirectory } from './local-path';
import { localLines } from './local-lines';
import { enforceToolPermissions } from './permissions';

const str = { type: 'string' };
const board = { board: str };
const schema = (properties: object, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
export const localTools = [
  { name: 'attach_conversation', description: 'Attach this existing loaded conversation through its shared app-server socket. Never creates a conversation. Supply the current thread ID and optional absolute control socket path.', inputSchema: schema({ ...board, threadId: str, socketPath: str }, ['board', 'threadId']) },
  { name: 'list_boards', description: 'List local architecture boards.', inputSchema: schema({}, []) },
  { name: 'open_board', description: 'Create a named board in this repository.', inputSchema: schema({ name: str }, ['name']) },
  { name: 'read_board', description: 'Read the latest graph, revision, code references and review notes. Read before editing.', inputSchema: schema(board, ['board']) },
  { name: 'apply_board', description: 'Atomically edit the board at the revision read. Supported operations: node.put and edge.put (optional existing id and patch); element.delete (id); note.add (target, text); note.reply (id, text); note.resolve (id, resolved). Omit position fields when updating nodes to preserve user layout. New IDs are assigned by the server. Read the result before referencing a newly created element.', inputSchema: schema({ ...board, revision: { type: 'integer', minimum: 0 }, operations: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object' } } }, ['board', 'revision', 'operations']) },
  { name: 'read_code', description: 'Inspect an in-repository code reference. Protected files cannot be read.', inputSchema: schema({ ...board, ref: schema({ path: str, start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 } }, ['path', 'start', 'end']) }, ['board', 'ref']) },
];
export function localEndpoint(args: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--repo', '--store'].includes(args[i]) || !args[i + 1]) throw new Error('REJECTED: use --repo path or --store path');
    values.set(args[i], args[i + 1]);
  }
  const repo = realpathSync(values.get('--repo') ?? process.cwd());
  const directory = resolve(values.get('--store') ?? localDirectory(repo));
  const endpoint = JSON.parse(readFileSync(join(directory, 'endpoint.json'), 'utf8'));
  const url = new URL(endpoint.origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== endpoint.origin || !/^[a-f0-9]{64}$/.test(endpoint.token) || endpoint.repo !== repo) throw new Error('REJECTED: invalid local endpoint; restart the board server');
  return endpoint as { origin: string; token: string };
}
export async function localCall(endpoint: { origin: string; token: string }, input: unknown, signal = AbortSignal.timeout(30000)) {
  const response = await fetch(`${endpoint.origin}/api/call`, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal, redirect: 'error' });
  const result = await response.json() as any;
  if (!response.ok) throw new Error(result.error ?? 'UNAVAILABLE: local request failed');
  return result;
}
export async function runLocalMcp(args: string[]) {
  // Plugin MCP processes start in the plugin directory, not the user's checkout.
  const perRepo = args.length === 1 && args[0] === '--per-repo';
  const tools = perRepo ? localTools.map(tool => ({ ...tool, inputSchema: schema({ ...tool.inputSchema.properties, repo: { type: 'string', description: 'Absolute path of the current repository. Pass it on every call.' } }, [...tool.inputSchema.required, 'repo']) })) : localTools;
  for await (const line of localLines(process.stdin, 1024 * 1024, message => process.stderr.write(`${message}\n`))) {
    let request: any;
    let answer: object;
    try { request = JSON.parse(line); }
    catch { answer = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'REJECTED: invalid JSON' } }; await write(answer); continue; }
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') { await write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'REJECTED: invalid request' } }); continue; }
    if (request.id === undefined) continue;
    try {
      let result: unknown;
      switch (request.method) {
        case 'initialize': result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'draw-local', version: '1.0.0' } }; break;
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools }; break;
        case 'tools/call': {
          const { name, arguments: input } = request.params ?? {};
          if (!localTools.some(t => t.name === name) || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('REJECTED: unsupported tool or invalid arguments');
          try {
            enforceToolPermissions(name, 'local');
            if (perRepo && (typeof input.repo !== 'string' || !isAbsolute(input.repo))) throw new Error('REJECTED: pass the absolute current repository path as repo');
            result = { content: [{ type: 'text', text: JSON.stringify(await localCall(localEndpoint(perRepo ? ['--repo', input.repo] : args), { ...input, action: name })) }] };
          }
          catch (error) { result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'UNAVAILABLE: local server is unavailable' }] }; }
          break;
        }
        default: await write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'REJECTED: method not supported' } }); continue;
      }
      answer = { jsonrpc: '2.0', id: request.id, result };
    } catch (error) { answer = { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: error instanceof Error ? error.message : 'REJECTED: invalid arguments' } }; }
    await write(answer);
  }
  return 0;
}
async function write(value: object) { if (!process.stdout.write(`${JSON.stringify(value)}\n`)) await once(process.stdout, 'drain'); }
