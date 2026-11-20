import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import hostedTools from './hosted-tools.json';
import { localToolName, assertHostedArguments } from './router-names';
import { localCall, localEndpoint, localTools } from './local-mcp';
import { localCommand } from './local-runtime';
import { enforceToolPermissions } from './permissions';
import { installedEndpoints, localViewerUrl, sharingInstance, validMcpUrl } from './hosted-url';
import { DEFAULT_ORIGIN } from './capture';

export function routerUrl(arg?: string) {
  const url = validMcpUrl(arg ?? process.env.REDCRAYON_MCP_URL ?? DEFAULT_ORIGIN + '/mcp');
  if (!url) throw new Error('Invalid hosted Draw endpoint.');
  return url;
}

export function loginUrl(args: string[]) {
  if (args.length === 2 && args[0] === '--url') return routerUrl(args[1]);
  if (args.length) throw new Error('Usage: draw login [--url <MCP endpoint>]');
  if (process.env.REDCRAYON_MCP_URL) return routerUrl();
  const endpoints = installedEndpoints();
  if (endpoints.size > 1) throw new Error('Your agents use different Draw instances. Choose one with draw login --url <MCP endpoint>.');
  return routerUrl([...endpoints][0]);
}

async function hostedClient(url: string) {
  const [command, ...prefix] = localCommand();
  const client = new Client({ name: 'draw', version: '1' });
  const transport = new StdioClientTransport({ command, args: [...prefix, 'hosted-transport', url],
    env: Object.fromEntries(['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'BROWSER', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])), stderr: 'inherit' });
  try {
    await client.connect(transport, { timeout: 180_000 });
    return client;
  } catch (error) { await transport.close(); throw error; }
}

export async function login(url: string) {
  const client = await hostedClient(url);
  try { await client.listTools(); } finally { await client.close(); }
  console.error('Connected to ' + new URL(url).origin);
}

// Hosted tools keep their wire names so existing capture and conversation hooks still match.
const localNames = new Map(localTools.map(t => [localToolName(t.name), t.name]));
const catalog = [...localTools.map(t => ({ ...t, name: localToolName(t.name),
  description: 'Local board. ' + t.description, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, repo: { type: 'string', description: 'Absolute repository directory.' } }, required: [...t.inputSchema.required, 'repo'] } })),
  ...hostedTools.map(t => ({ ...t, description: 'Hosted Draw. ' + t.description }))];

export async function runRouter(url: string) {
  let connection: Promise<Client> | undefined;
  const server = new Server({ name: 'draw', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    const { name, arguments: input = {} } = params;
    try {
      const local = localNames.get(name);
      if (local) {
        enforceToolPermissions(local, 'local', input);
        if (typeof input.repo !== 'string' || !isAbsolute(input.repo)) throw new Error('Pass the absolute repository path as repo.');
        const args = ['--repo', input.repo];
        if (local === 'list_boards' || local === 'open_board' || local === 'read_board') {
          const [command, ...prefix] = localCommand();
          await promisify(execFile)(command, [...prefix, 'local', '--background', ...args], { signal });
        }
        const board = await localCall(localEndpoint(args), { ...input, action: local }, signal);
        if (board?.url) board.url = localViewerUrl(board.url, sharingInstance(url));
        return { content: [{ type: 'text', text: JSON.stringify(board) }] };
      }
      if (!hostedTools.some(t => t.name === name)) throw new Error('Unknown Draw tool.');
      assertHostedArguments(input);
      enforceToolPermissions(name, 'hosted', input);
      connection ??= hostedClient(url).then(client => {
        client.onclose = () => { connection = undefined; };
        return client;
      }).catch(error => { connection = undefined; throw error; });
      return await (await connection).callTool({ name, arguments: input }, undefined, { signal, timeout: 180_000 });
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : 'Draw request failed.' }] };
    }
  });
  await server.connect(new StdioServerTransport());
  await new Promise<void>(resolve => {
    process.stdin.once('end', resolve);
    if (process.stdin.readableEnded) resolve();
  });
  await (await connection?.catch(() => undefined))?.close();
  await server.close();
}
