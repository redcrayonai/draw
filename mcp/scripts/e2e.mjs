#!/usr/bin/env node
// The staging e2e (spec §9 step 7; §12 Sign-in): the deployed mcp Worker as
// clients see it, through MCP SDK clients of both protocol eras, with real
// helper captures.
//
//   MCP_URL=https://staging.mcp.<domain>/mcp E2E_API_KEY=<a key in the Worker's MCP_API_KEYS> \
//   OIDC_ISSUER=<the Worker's OIDC_ISSUER> APP_ORIGIN=https://staging.draw.<domain> \
//   [EXPECTED_VERSION=<git sha>] node mcp/scripts/e2e.mjs
//
// Locally, against `wrangler dev` with DEV_AUTH=1, leave E2E_API_KEY unset:
// DEV_AUTH signs every localhost request in, so the 401 check is skipped.
// Needs the helper built (pnpm -C helper run build). Exits 1 on the first failure.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { connect, fetchSeen, headersSeen, healthy, need } from './client.mjs';

const mcpUrl = need('MCP_URL');
const idp = need('OIDC_ISSUER');
const app = process.env.APP_ORIGIN?.replace(/\/+$/, '');
const key = process.env.E2E_API_KEY;
const version = process.env.EXPECTED_VERSION?.slice(0, 12);
const origin = new URL(mcpUrl).origin;

// Every header a response may carry: ours (app.ts), the platform's, and Cloudflare's (D15).
const ALLOWED_HEADERS = new Set([
  'content-type', 'content-length', 'content-encoding', 'date', 'connection', 'keep-alive', 'transfer-encoding', 'vary',
  'cache-control', 'retry-after', 'allow', 'www-authenticate', 'mcp-session-id', 'mcp-protocol-version', 'x-accel-buffering',
  'access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods', 'access-control-expose-headers',
  'server', 'cf-ray', 'cf-cache-status', 'alt-svc', 'nel', 'report-to', 'server-timing', 'strict-transport-security',
]);

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`FAIL ${name}\n${err instanceof Error ? err.message : err}`);
    throw Object.assign(new Error(name), { reported: true });
  }
  passed++;
  console.log(`ok ${name}`);
}

// TOOL_NAMES from mcp/src/tools.ts itself, bundled as scripts/surface.mjs does.
async function toolNames() {
  const outfile = new URL('../dist/e2e-tools.mjs', import.meta.url).pathname;
  await build({
    stdin: { contents: "export { TOOL_NAMES } from './src/tools';", resolveDir: new URL('..', import.meta.url).pathname, loader: 'ts' },
    bundle: true, outfile, platform: 'node', format: 'esm', define: { 'process.browser': 'true' }, logLevel: 'error',
  });
  return (await import(outfile)).TOOL_NAMES;
}

// A throwaway checkout, and the helper as an agent runs it.
const GIT = { GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const helper = new URL('../../helper/dist/redcrayon.mjs', import.meta.url).pathname;
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'rc-e2e-')));
const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, ...GIT }, stdio: 'pipe' }).toString().trim();
const write = (rel, text) => {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), text);
};
const capture = (...args) => execFileSync('node', [helper, 'capture', ...args], { cwd: repo, env: { ...process.env, ...GIT, REDCRAYON_ORIGIN: origin }, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

git('init', '-q', '-b', 'main');
write('src/limiter.ts', 'export class Limiter {\n  allow(used: number): boolean {\n    return used < 10;\n  }\n}\n');
write('src/server.ts', "import { Limiter } from './limiter';\nexport const handle = (n: number) => new Limiter().allow(n);\n");
git('add', '-A');
git('commit', '-q', '-m', 'base');
const baseSha = git('rev-parse', 'HEAD');

try {
  await check(`/health is ok${version ? ` on ${version}` : ''}`, () => healthy(origin, version));

  if (key) {
    await check('POST /mcp without a token: 401, the exact body and WWW-Authenticate', async () => {
      const res = await fetchSeen(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 401);
      assert.equal(await res.text(), JSON.stringify({ error: 'invalid_token', error_description: "Sign in to redcrayon from your agent's MCP settings." }));
      assert.equal(res.headers.get('www-authenticate'), `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="board:read board:write"`);
    });
  } else {
    console.log('skip 401 check: no E2E_API_KEY, so the Worker runs with DEV_AUTH');
  }

  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    await check(`${path} byte for byte`, async () => {
      const res = await fetchSeen(`${origin}${path}`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), `{"resource":"${origin}/mcp","authorization_servers":["${idp}"],"scopes_supported":["board:read","board:write"]}`);
    });
  }

  const expectedTools = [...(await toolNames())].sort();
  const stamp = Date.now().toString(36);

  for (const era of ['v1', 'v2']) {
    const { client, call } = await connect(era, mcpUrl, key);
    const ok = async (name, args) => {
      const r = await call(name, args);
      assert.equal(r.isError, false, `${name}: ${r.text}`);
      return r.text;
    };

    await check(`${era}: tools/list is mcp/src/tools.ts TOOL_NAMES (${expectedTools.length})`, async () => {
      assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), expectedTools);
    });

    const name = `e2e-${era}-${stamp}`;
    let started;
    await check(`${era}: start_session on a capture opens a session board`, async () => {
      started = JSON.parse(await ok('start_session', { name, capture: capture('start') }));
      assert.equal(started.board, name);
      assert.equal(started.session, true);
      assert.equal(started.checkpoint, 0);
      assert.equal(started.repoRoot, repo);
      assert.equal(started.baseSha, baseSha);
      const returned = new URL(started.url);
      if (app) assert.equal(returned.origin, app);
      assert.equal(returned.searchParams.get('boardId'), null);
      assert.match(new URLSearchParams(returned.hash.slice(1)).get('b') ?? '', /^[0-9a-f]{20}$/);
      assert.equal(returned.searchParams.get('db'), null); // APP_ORIGIN serves DB_NAME, so its links never name it
    });
    const board = String(started.id);
    const committed = (text, re = /^committed id=(\d+) board=/) => {
      const m = re.exec(text);
      assert.ok(m, text);
      return m[1];
    };

    const ids = {};
    await check(`${era}: 3 nodes`, async () => {
      for (const [label, x] of [['Server', 0], ['Limiter', 240], ['Store', 480]]) {
        ids[label] = committed(await ok('create_node', { board, label, sublabel: '', x, y: 0, w: 160, h: 64, token: 'ink', focal: false }));
      }
    });

    const edges = {};
    await check(`${era}: 2 edges, one with source: evidence on a cite capture`, async () => {
      edges.uses = committed(await ok('create_edge', { board, fromNode: ids.Server, toNode: ids.Limiter, label: 'uses', evidence: 'source:src/server.ts:1', capture: capture('cite', 'src/server.ts', '--board', board) }));
      edges.writes = committed(await ok('create_edge', { board, fromNode: ids.Limiter, toNode: ids.Store, label: 'writes', evidence: 'import' }));
    });

    await check(`${era}: add_code_ref on a TS symbol from a ref capture`, async () => {
      const text = await ok('add_code_ref', { board, targetKind: 'node', targetId: ids.Limiter, path: 'src/limiter.ts', symbol: 'Limiter.allow', capture: capture('ref', 'src/limiter.ts', '--board', board) });
      assert.match(text, new RegExp(`^committed id=\\d+ src/limiter\\.ts:2-4 board=${name}$`));
    });

    await check(`${era}: mark_checkpoint from a checkpoint capture`, async () => {
      const res = JSON.parse(await ok('mark_checkpoint', { board, capture: capture('checkpoint', '--board', board, '--base', baseSha) }));
      assert.equal(res.board, name);
      assert.equal(res.checkpoint, 1);
      assert.deepEqual(res.coverage.uncovered, []);
      assert.deepEqual(res.citedPaths, ['src/limiter.ts', 'src/server.ts']);
    });

    await check(`${era}: get_board holds every row`, async () => {
      const snap = JSON.parse(await ok('get_board', { board }));
      assert.equal(snap.board, name);
      assert.equal(snap.session.checkpoint, 1);
      assert.equal(snap.session.headSha, baseSha);
      const row = n => ({ id: n.id, label: n.label, x: n.x, y: n.y, w: n.w, h: n.h, token: n.token, focal: n.focal, hidden: n.hidden });
      assert.deepEqual(snap.nodes.map(row), [
        { id: ids.Server, label: 'Server', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false, hidden: false },
        { id: ids.Limiter, label: 'Limiter', x: 240, y: 0, w: 160, h: 64, token: 'ink', focal: false, hidden: false },
        { id: ids.Store, label: 'Store', x: 480, y: 0, w: 160, h: 64, token: 'ink', focal: false, hidden: false },
      ]);
      const refs = Object.fromEntries(snap.nodes.map(n => [n.label, n.refs.map(({ id, ...r }) => r)]));
      assert.deepEqual(refs, { Server: [], Limiter: [{ symbol: 'Limiter.allow', path: 'src/limiter.ts', startLine: 2, endLine: 4, checkpoint: 1, status: 'ok' }], Store: [] });
      assert.deepEqual(
        snap.edges.map(e => ({ id: e.id, from: e.from, to: e.to, label: e.label, evidence: e.evidence, evidenceStatus: e.evidenceStatus, hidden: e.hidden, refs: e.refs })),
        [
          { id: edges.uses, from: ids.Server, to: ids.Limiter, label: 'uses', evidence: 'source:src/server.ts:1', evidenceStatus: 'ok', hidden: false, refs: [] },
          { id: edges.writes, from: ids.Limiter, to: ids.Store, label: 'writes', evidence: 'import', evidenceStatus: '', hidden: false, refs: [] },
        ]
      );
    });
    await client.close();
  }

  await check('every response header is on the allowlist', () => {
    const extra = [...headersSeen].filter(h => !ALLOWED_HEADERS.has(h));
    assert.deepEqual(extra, [], `headers outside the allowlist: ${extra.join(', ')}`);
  });
  console.log(`e2e: ${passed} checks passed against ${mcpUrl}`);
} catch (err) {
  if (!err.reported) console.error(`FAIL ${err instanceof Error ? err.stack : err}`);
  process.exitCode = 1;
} finally {
  rmSync(repo, { recursive: true, force: true });
}
