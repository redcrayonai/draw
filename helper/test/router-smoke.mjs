// Exercise the packaged executable with a disposable repository, home and OAuth issuer.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const binary = resolve(process.argv[2]);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'draw-router-')));
const repo = join(root, 'repo');
mkdirSync(repo);
execFileSync('git', ['init', '-q', repo]);
const tools = [
  { name: 'get_board', inputSchema: { type: 'object', properties: { board: { type: 'string' } } } },
];
let exchanges = 0,
  refreshes = 0,
  requests = 0,
  currentToken = '',
  challenge = '';
const host = createServer(async (req, res) => {
  const url = new URL(req.url, base);
  const body = [];
  for await (const part of req) body.push(part);
  const raw = Buffer.concat(body).toString();
  const json = (code, data, headers = {}) =>
    res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(data));
  if (url.pathname.includes('oauth-protected-resource'))
    return json(200, {
      resource: base + '/mcp',
      authorization_servers: [base],
      scopes_supported: ['board:read', 'board:write'],
    });
  if (url.pathname.includes('well-known'))
    return json(200, {
      issuer: base,
      authorization_endpoint: base + '/authorize',
      token_endpoint: base + '/token',
      registration_endpoint: base + '/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
    });
  if (url.pathname === '/register') return json(201, { ...JSON.parse(raw), client_id: 'draw-test' });
  if (url.pathname === '/authorize') {
    challenge = url.searchParams.get('code_challenge');
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', url.searchParams.get('state'));
    callback.searchParams.set('code', 'test-code');
    return res.writeHead(302, { location: callback.href }).end();
  }
  if (url.pathname === '/token') {
    const input = new URLSearchParams(raw);
    if (input.get('grant_type') === 'refresh_token') {
      assert.equal(input.get('refresh_token'), 'fixture-refresh');
      refreshes++;
    } else {
      assert.equal(input.get('code'), 'test-code');
      assert.equal(createHash('sha256').update(input.get('code_verifier')).digest('base64url'), challenge);
      exchanges++;
    }
    currentToken = randomUUID();
    return json(200, {
      access_token: currentToken,
      token_type: 'Bearer',
      refresh_token: 'fixture-refresh',
      expires_in: 3600,
    });
  }
  if (url.pathname !== '/mcp') return json(404, {});
  requests++;
  if (!currentToken || req.headers.authorization !== 'Bearer ' + currentToken)
    return json(
      401,
      {},
      {
        'WWW-Authenticate':
          'Bearer resource_metadata="' + base + '/.well-known/oauth-protected-resource/mcp"',
      },
    );
  if (req.method !== 'POST') return json(405, {});
  const rpc = JSON.parse(raw);
  if (rpc.id === undefined) return res.writeHead(202).end();
  const result =
    rpc.method === 'initialize'
      ? {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1' },
        }
      : rpc.method === 'tools/list'
        ? { tools }
        : rpc.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'Hosted board ' + rpc.params.arguments.board }] }
          : undefined;
  json(200, {
    jsonrpc: '2.0',
    id: rpc.id,
    ...(result ? { result } : { error: { code: -32601, message: 'Method not found' } }),
  });
});
await new Promise((r) => host.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + host.address().port;
const env = {
  HOME: root,
  PATH: root + ':' + process.env.PATH,
  REDCRAYON_MCP_URL: base + '/mcp',
  DRAW_NO_UPDATE_CHECK: '1',
};
// The fake desktop opener follows only this fixture's authorization URL.
for (const cmd of ['open', 'xdg-open'])
  writeFileSync(
    join(root, cmd),
    '#!/bin/sh\ncase "$1" in ' + base + '/authorize*) exec curl -fsSL "$1" -o /dev/null;; esac\nexit 1\n',
    { mode: 0o700 },
  );
let client;
async function connect() {
  client = new Client({ name: 'native-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: binary, args: ['mcp'], env, stderr: 'inherit' }));
}
async function invoke(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, result.content[0].text);
  return result.content[0].text;
}
try {
  await connect();
  const list = await client.listTools();
  assert.equal(client.getServerVersion().name, 'draw');
  assert.ok(list.tools.some((t) => t.name === 'apply_local_board'));
  assert.ok(list.tools.some((t) => t.name === 'get_board'));
  const [board, other] = await Promise.all(
    ['Local', 'Other'].map(async name => JSON.parse(await invoke('open_board', { repo, name }))),
  );
  assert.equal(new URL(other.url).origin, new URL(board.url).origin);
  assert.equal(new URL(board.url).searchParams.get('instance'), new URL(base).host);
  const secondRepo = join(root, 'second');
  mkdirSync(secondRepo);
  const second = JSON.parse(await invoke('open_board', { repo: secondRepo, name: 'Second repo' }));
  async function preference(board, input) {
    const viewer = new URL(board.url);
    const key = new URLSearchParams(viewer.hash.slice(1)).get('key');
    const response = await fetch(viewer.origin + '/api/call', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  await preference(board, { action: 'set_sharing_preference', skip: true });
  assert.equal((await preference(second, { action: 'sharing_preference' })).skip, true);
  await invoke('apply_local_board', {
    repo,
    board: board.slug,
    revision: 0,
    operations: [{ type: 'node.put', patch: { label: 'Saved locally' } }],
  });
  assert.equal(
    JSON.parse(await invoke('read_board', { repo, board: board.slug })).nodes[0].label,
    'Saved locally',
  );
  const cleanLocal = new URL(board.url);
  cleanLocal.hash = 'b=' + board.slug;
  for (const [name, args] of [
    ['list_boards', { repo: '.' }], ['unknown_tool', {}], ['get_board', { board: board.slug }],
    ...[board.url, cleanLocal.href, board.slug, 'malformed link'].map(link => ['start_session', { link }]),
  ]) {
    const refused = await client.callTool({ name, arguments: args });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /^REJECTED:/);
  }
  assert.equal(requests, 0);
  await invoke('start_session', { link: 'http://localhost:5173/#b=0123456789abcdef1234' });
  assert.equal(await invoke('get_board', { board: '42' }), 'Hosted board 42');
  await client.close();
  await connect();
  assert.equal(await invoke('get_board', { board: '42' }), 'Hosted board 42');
  assert.equal(exchanges, 1);
  const login = await promisify(execFile)(binary, ['login', '--url', base + '/mcp'], { env, timeout: 30000 });
  assert.ok(login.stderr.includes('Connected to ' + base));
  currentToken = 'expired';
  await client.close();
  await connect();
  assert.equal(await invoke('get_board', { board: '42' }), 'Hosted board 42');
  assert.equal(exchanges, 1);
  assert.ok(refreshes > 0);
  console.log('One native entry: offline local edits, hosted PKCE, restart and refresh passed.');
} finally {
  await client?.close();
  host.closeAllConnections();
  host.close();
  for (const directory of [repo, join(root, 'second')]) {
    const id = createHash('sha256').update(directory).digest('hex').slice(0, 24);
    const endpoint = join(root, '.redcrayon/local', id, 'endpoint.json');
    if (existsSync(endpoint)) process.kill(JSON.parse(readFileSync(endpoint)).pid);
  }
  rmSync(root, { recursive: true, force: true });
}
