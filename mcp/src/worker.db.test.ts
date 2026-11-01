// The Worker against a real local DB (spec §12 Verification, "Real local DB in
// CI"): app.ts served on a local port, so the DB fetches our issuer's JWKS
// from it, driven by the MCP SDK clients of both protocol eras. The token
// verifier is a lookup table. Needs STDB_URL and STDB_DB: scripts/stdb-test.sh mcp.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client as ClientV2, StreamableHTTPClientTransport as TransportV2 } from '@modelcontextprotocol/client';
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as TransportV1 } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { importJWK, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbHttp, identityArg } from '../../shared/db-http';
import { identityFromClaims } from '../../shared/identity';
import { newShareToken, shareHref } from '../../shared/share-link';
import { createWorker } from './app';
import { dbLoad } from './canary';
import { database } from './db';
import { sha256, type VerifyBearer } from './auth';
import type { Env } from './env';
import { SERVICE_SUBJECT, jwks, mint } from './issuer';
import { TOOL_NAMES } from './tools';
import { UserLedger, type Storage } from './user';
import { memoryCaptures, newJwk } from './test/env';

const url = process.env.STDB_URL;
const db = process.env.STDB_DB;
const owner = process.env.STDB_OWNER_TOKEN;

const USERS: Record<string, string> = { tok_ada: 'user_ada', tok_bob: 'user_bob', tok_cleo: 'user_cleo' };
const verifyBearer: VerifyBearer = async auth => {
  const userId = USERS[auth.replace('Bearer ', '')];
  return userId ? { userId, clientId: 'client_test', via: 'oauth', scopes: ['board:read', 'board:write'] } : null;
};
const memory = (): Storage => {
  const m = new Map<string, unknown>();
  return { get: async <T>(k: string) => m.get(k) as T | undefined, put: async (k, v) => void m.set(k, v) };
};

describe.skipIf(!url || !db)('the Worker on a real DB', () => {
  let server: Server;
  let env: Env;
  let base: string;
  const ledgers = new Map<string, UserLedger>();
  const captures = memoryCaptures();
  const app = createWorker({
    verifyBearer: () => verifyBearer,
    users: () => async userId => ({ name: userId === 'user_ada' ? 'Ada' : 'Bob', plan: 'free' }),
  });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      // The browser and Worker issuers share this local server, just as both use one trusted DB.
      const browserPath = new URL(env.OIDC_ISSUER).pathname;
      if (req.url === `${browserPath}/.well-known/openid-configuration` || req.url === `${browserPath}/jwks.json`) {
        const body = req.url.endsWith('/jwks.json') ? jwks(env) : {
          issuer: env.OIDC_ISSUER, jwks_uri: `${env.OIDC_ISSUER}/jwks.json`,
          id_token_signing_alg_values_supported: ['ES256'], response_types_supported: ['id_token'], subject_types_supported: ['public'],
        };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const request = new Request(`${base}${req.url}`, {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v] as [string, string]] : [])),
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
      });
      const response = await app.fetch(request, env);
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => (headers[k] = v));
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    // On the issuer the published module trusts (scripts/stdb-test.sh exports it), so its
    // hosted-agent rules apply to our agents; anywhere else when run by hand.
    const ours = process.env.MCP_ORIGIN ? Number(new URL(process.env.MCP_ORIGIN).port) : 0;
    await new Promise<void>(r => server.listen(ours, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    env = {
      MCP_ORIGIN: base,
      APP_ORIGIN: 'https://app.redcrayon.test',
      OIDC_ISSUER: process.env.OIDC_ISSUER ?? process.env.BROWSER_ISSUER ?? 'https://auth.redcrayon.test',
      DB_URL: url!,
      DB_NAME: db!,
      AGENT_JWK: await newJwk('k1'),
      VERSION: 'dbtest000000',
      USER: {
        idFromName: (id: string) => id,
        get: (id: string) => ledgers.get(id) ?? ledgers.set(id, new UserLedger(memory())).get(id)!,
      } as never,
      CAPTURE: { idFromName: (id: string) => id, get: captures } as never,
    };
    // The Worker's own identity, seeded as each environment's runbook says, so it can link agents to owners.
    if (owner) {
      const service = identityFromClaims(`${base}/agent-id`, 'service:mcp');
      await dbHttp(url!, db!).sqlAs(owner, `INSERT INTO service_account (identity, label) VALUES (0x${service}, 'mcp')`);
    }
  });
  afterAll(() => new Promise<void>(r => server.close(() => r())));

  async function browserToken(userId: string) {
    const jwk = JSON.parse(env.AGENT_JWK);
    return new SignJWT({ sid: `session_${userId}`, azp: process.env.APP_ORIGINS?.split(',')[0] ?? 'http://localhost:5173' })
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
      .setIssuer(env.OIDC_ISSUER).setSubject(userId).setIssuedAt().setExpirationTime('15m')
      .sign(await importJWK(jwk, 'ES256'));
  }

  for (const era of ['v1', 'v2'] as const) {
    describe(`with a ${era} client`, () => {
      async function connect(token: string) {
        const opts = { requestInit: { headers: { authorization: `Bearer ${token}` } } };
        const client = era === 'v1' ? new ClientV1({ name: 'test', version: '1' }) : new ClientV2({ name: 'test', version: '1' });
        const transport = era === 'v1' ? new TransportV1(new URL(`${base}/mcp`), opts) : new TransportV2(new URL(`${base}/mcp`), opts);
        await (client as ClientV1).connect(transport as never);
        const call = async (name: string, args: Record<string, unknown> = {}) => {
          const res = (await (client as ClientV1).callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
          return { text: res.content[0].text, isError: res.isError === true };
        };
        return { client: client as ClientV1, call };
      }

      it('applies one drawing pass, preserving ids on a retry and refusing endpoints on another board', async () => {
        const { client, call } = await connect('tok_ada');
        try {
          const started = JSON.parse((await call('start_session', { name: `batch-${era}` })).text);
          const board = String(started.id);
          const node = (key: string, x: number) => ({ key, label: key, sublabel: '', x, y: 0, w: 160, h: 64, token: 'ink', focal: false });
          const args = { board, nodes: [node('api', 0), node('store', 240)], edges: [{ fromNode: '$api', toNode: '$store', label: 'writes', evidence: 'agent:user described the topology' }], layout: true };
          const first = await call('apply_board', args);
          expect(first.isError, first.text).toBe(false);
          const result = JSON.parse(first.text);
          expect(result).toMatchObject({ complete: true, nodes: { api: expect.stringMatching(/^\d+$/), store: expect.stringMatching(/^\d+$/) }, edges: [expect.stringMatching(/^\d+$/)] });
          const retry = await call('apply_board', args);
          expect(retry.isError, retry.text).toBe(false);
          expect(JSON.parse(retry.text).nodes).toEqual(result.nodes);
          const snapshot = JSON.parse((await call('get_board', { board })).text);
          expect(snapshot.nodes).toHaveLength(2);
          expect(snapshot.edges).toHaveLength(1);
          expect(snapshot.edges[0]).toMatchObject({ from: result.nodes.api, to: result.nodes.store });

          const other = JSON.parse((await call('start_session', { name: `batch-other-${era}` })).text);
          const denied = await call('apply_board', { board: String(other.id), edges: [{ ...args.edges[0], fromNode: result.nodes.api, toNode: result.nodes.store }] });
          expect(denied.isError).toBe(true);
          expect(denied.text).toMatch(/^REJECTED/);
          expect(JSON.parse((await call('get_board', { board: String(other.id) })).text).edges).toHaveLength(0);
        } finally {
          await client.close();
        }
      });

      async function workspaceBoard(scenario: string, bobRole = 'editor') {
        const http = dbHttp(url!, db!);
        const ada = await browserToken('user_ada'), bob = await browserToken('user_bob');
        const bobIdentity = identityFromClaims(env.OIDC_ISSUER, 'user_bob');
        // Direct membership changes require a person who has genuinely signed in.
        await http.sqlAs(bob, 'SELECT * FROM my_workspaces');
        const name = `native-${scenario}-${era}`;
        await http.callAs(ada, 'create_workspace', [name]);
        const [workspace] = await http.sqlAs(ada, `SELECT * FROM my_workspaces WHERE name = '${name}'`);
        await http.callAs(ada, 'set_workspace_member', [workspace.id, identityArg(bobIdentity), 'member']);
        await http.callAs(ada, 'create_workspace_board', [workspace.id, name, name]);
        const [board] = await http.sqlAs(ada, `SELECT * FROM my_boards WHERE name = '${name}'`);
        await http.callAs(ada, 'set_workspace_board_member', [board.board_id, identityArg(bobIdentity), bobRole]);
        const [row] = await http.sqlAs(ada, `SELECT * FROM visible_board WHERE id = ${board.board_id}`);
        return { http, ada, bob, bobIdentity, workspaceId: workspace.id, board: String(board.board_id), link: `${env.APP_ORIGIN}/#b=${row.slug}` };
      }

      async function machineKeys(scenario: string) {
        const f = await workspaceBoard(`machine-${scenario}`);
        const name = `CI ${scenario} ${era}`;
        await f.http.callAs(f.ada, 'create_workspace_service_account', [f.workspaceId, name, 'editor', true, []]);
        const [account] = await f.http.sqlAs(f.ada, `SELECT * FROM my_workspace_service_accounts WHERE workspace_id = ${f.workspaceId}`);
        const issue = async (role = 'editor', boardIds = [BigInt(f.board)]) => {
          const keyId = newShareToken(), bearer = `rcak_${keyId}_${newShareToken()}${newShareToken()}`;
          await f.http.callAs(f.ada, 'create_workspace_api_key', [account.id, keyId, await sha256(bearer), role, role, false, boardIds, { none: [] }]);
          return { keyId, bearer, token: await mint(env, `machine:${keyId}`) };
        };
        return { ...f, account, name, issue };
      }

      const machineNodeArgs = (board: string) => [BigInt(board), 'Direct key write', '', 0, 0, 160, 64, 'ink', false, ...Array(7).fill({ none: [] })];
      const drawnNode = (board: string) => ({ board, label: 'Build bot', sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false });

      it.skipIf(!owner)('keeps managed keys scoped to their selected boards and separates viewer/editor rights from human administration', async () => {
        const f = await machineKeys('scopes');
        const editKey = await f.issue(), readKey = await f.issue('viewer');
        const editor = await connect(editKey.bearer), reader = await connect(readKey.bearer);
        try {
          expect((await editor.call('get_board', { board: f.board })).isError).toBe(false);
          expect((await reader.call('get_board', { board: f.board })).isError).toBe(false);
          expect((await editor.call('start_session', { link: f.link })).isError).toBe(false);
          expect((await editor.call('create_node', drawnNode(f.board))).isError).toBe(false);
          await expect(reader.call('create_node', drawnNode(f.board))).rejects.toThrow(/403|scope/);
          await expect(f.http.callAs(readKey.token, 'create_node', machineNodeArgs(f.board))).rejects.toThrow(/read only/);
          expect((await editor.call('start_session', { name: `forbidden-machine-${era}` })).isError).toBe(true);
          expect((await editor.call('start_tap', { board: f.board })).text).toMatch(/service accounts cannot start a live tap/);
          await f.http.callAs(f.ada, 'create_workspace_board', [f.workspaceId, `outside-key-${era}`, `outside-key-${era}`]);
          const [outside] = await f.http.sqlAs(f.ada, `SELECT * FROM my_boards WHERE name = 'outside-key-${era}'`);
          await f.http.sqlAs(owner!, `INSERT INTO public_board (board_id) VALUES (${outside.board_id})`);
          const share = newShareToken();
          await f.http.callAs(f.ada, 'set_link_share', [outside.board_id, 'edit', share]);
          expect((await editor.call('get_board', { board: String(outside.board_id) })).isError).toBe(true);
          expect((await editor.call('start_session', { link: shareHref(env.APP_ORIGIN, db!, share) })).isError).toBe(true);
          expect(await f.http.sqlAs(editKey.token, `SELECT * FROM visible_board WHERE id = ${outside.board_id}`)).toEqual([]);
          await expect(f.http.callAs(editKey.token, 'set_workspace_member', [f.workspaceId, identityArg(f.bobIdentity), 'admin'])).rejects.toThrow(/human account/);
          await expect(f.http.callAs(editKey.token, 'set_link_share', [BigInt(f.board), 'edit', newShareToken()])).rejects.toThrow(/owner|manager/);
          const identity = identityFromClaims(`${base}/agent-id`, `machine:${editKey.keyId}`);
          expect(await f.http.sqlAs(owner!, `SELECT * FROM agent_link WHERE agent = 0x${identity}`)).toEqual([]);
        } finally { await Promise.all([editor.client.close(), reader.client.close()]); }
      });

      it.skipIf(!owner)('applies account narrowing, disablement, and individual key revocation despite cached database JWTs', async () => {
        const f = await machineKeys('revoke');
        const first = await f.issue(), rotated = await f.issue();
        const oldClient = await connect(first.bearer), newClient = await connect(rotated.bearer);
        try {
          expect((await oldClient.call('get_board', { board: f.board })).isError).toBe(false);
          expect((await newClient.call('get_board', { board: f.board })).isError).toBe(false);
          await f.http.callAs(f.ada, 'update_workspace_service_account', [f.account.id, f.name, 'viewer', true, [], false]);
          await expect(oldClient.call('create_node', drawnNode(f.board))).rejects.toThrow(/403|scope/);
          await expect(f.http.callAs(first.token, 'create_node', machineNodeArgs(f.board))).rejects.toThrow(/read only/);
          expect((await oldClient.call('get_board', { board: f.board })).isError).toBe(false);
          await f.http.callAs(f.ada, 'update_workspace_service_account', [f.account.id, f.name, 'editor', true, [], false]);
          expect((await newClient.call('create_node', drawnNode(f.board))).isError).toBe(false);
          await f.http.callAs(f.ada, 'revoke_workspace_api_key', [first.keyId]);
          await expect(oldClient.call('get_board', { board: f.board })).rejects.toThrow(/401|invalid_token/);
          expect(await f.http.sqlAs(first.token, `SELECT * FROM visible_board WHERE id = ${f.board}`)).toEqual([]);
          await expect(f.http.callAs(first.token, 'create_node', machineNodeArgs(f.board))).rejects.toThrow(/unavailable|authorized/);
          expect((await newClient.call('get_board', { board: f.board })).isError).toBe(false);
          await f.http.callAs(f.ada, 'update_workspace_service_account', [f.account.id, f.name, 'editor', true, [], true]);
          await expect(newClient.call('get_board', { board: f.board })).rejects.toThrow(/401|invalid_token/);
          expect(await f.http.sqlAs(rotated.token, `SELECT * FROM visible_board WHERE id = ${f.board}`)).toEqual([]);
        } finally { await Promise.all([oldClient.client.close(), newClient.client.close()]); }
      });

      it.skipIf(!owner)('never replays a captured session across keys or after board scope narrowing', async () => {
        const f = await machineKeys('cache');
        const repoRoot = `/private/company-repository-${era}`, sha = 'a'.repeat(40), name = `private-session-${era}`;
        await f.http.callAs(f.ada, 'start_session', [name, repoRoot, sha]);
        const [session] = await f.http.sqlAs(f.ada, `SELECT * FROM my_boards WHERE name = '${name}'`);
        await f.http.callAs(f.ada, 'move_board_to_workspace', [session.board_id, f.workspaceId]);
        const [row] = await f.http.sqlAs(f.ada, `SELECT * FROM visible_board WHERE id = ${session.board_id}`);
        const firstKey = await f.issue('editor', [BigInt(session.board_id as bigint)]), secondKey = await f.issue();
        const first = await connect(firstKey.bearer), second = await connect(secondKey.bearer);
        try {
          const uploaded = await fetch(`${base}/facts`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ v: 1, helper: '1.0.0', kind: 'start', toplevel: repoRoot, objectFormat: 'sha1', head: sha }),
          });
          const { capture } = await uploaded.json() as { capture: string };
          const args = { link: `${env.APP_ORIGIN}/#b=${row.slug}`, capture };
          expect(JSON.parse((await first.call('start_session', args)).text)).toMatchObject({ repoRoot, session: true });
          expect((await first.call('start_session', args)).text).toContain('same call');
          expect(await second.call('start_session', args)).toMatchObject({ isError: true, text: expect.not.stringContaining(repoRoot) });
          await f.http.callAs(f.ada, 'update_workspace_service_account', [f.account.id, f.name, 'editor', false, [BigInt(f.board)], false]);
          expect(await first.call('start_session', args)).toMatchObject({ isError: true, text: expect.not.stringContaining(repoRoot) });
          await f.http.callAs(f.ada, 'update_workspace_service_account', [f.account.id, f.name, 'viewer', true, [], false]);
          await expect(first.call('start_session', args)).rejects.toThrow(/403|scope/);
        } finally { await Promise.all([first.client.close(), second.client.close()]); }
      });

      it.skipIf(!owner)('delegates a workspace editor through the Worker without granting administration or proposal approval', async () => {
        const f = await workspaceBoard('editor');
        const ada = await connect('tok_ada'), bob = await connect('tok_bob');
        try {
          // A canonical locator delegates exactly this board; ordinary reads cannot obtain a grant.
          expect((await bob.call('get_board', { board: f.board })).isError).toBe(true);
          expect(JSON.parse((await ada.call('start_session', { link: f.link })).text).id).toBe(Number(f.board));
          expect(JSON.parse((await bob.call('start_session', { link: f.link })).text).id).toBe(Number(f.board));
          expect((await bob.call('create_node', { board: f.board, label: 'Editor agent', sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false })).isError).toBe(false);
          const branch = JSON.parse((await bob.call('create_branch', { board: f.board, name: `native-proposal-${era}` })).text);
          expect((await bob.call('submit_branch', { board: String(branch.id) })).isError).toBe(false);
          // The same signed agent remains unprivileged even when bypassing the MCP tool surface.
          for (const person of ['user_ada', 'user_bob']) {
            const token = await mint(env, `agent:${person}`);
            await expect(f.http.callAs(token, 'set_workspace_board_access', [BigInt(f.board), 'editor'])).rejects.toThrow(/human account/);
            await expect(f.http.callAs(token, 'set_workspace_member', [f.workspaceId, identityArg(f.bobIdentity), 'admin'])).rejects.toThrow(/human account/);
            await expect(f.http.callAs(token, 'review_architecture_proposal', [BigInt(branch.id), 'accept'])).rejects.toThrow(/only an owner|human owner/);
            await expect(f.http.callAs(token, 'merge_architecture_proposal', [BigInt(branch.id)])).rejects.toThrow(/human owner/);
          }
          expect((await f.http.sqlAs(owner!, `SELECT * FROM architecture_version WHERE board_id = ${branch.id}`))[0]).toMatchObject({ status: 'submitted' });
          expect((await ada.call('get_board', { board: f.board })).isError).toBe(false);
        } finally { await Promise.all([ada.client.close(), bob.client.close()]); }
      });

      it.skipIf(!owner)('cannot turn a viewer or another workspace owner into an editor by opening a board locator', async () => {
        const f = await workspaceBoard('viewer', 'viewer');
        const cleo = await browserToken('user_cleo');
        await f.http.callAs(cleo, 'create_workspace', [`other-company-${era}`]);
        for (const auth of ['tok_bob', 'tok_cleo']) {
          const agent = await connect(auth);
          try {
            expect((await agent.call('start_session', { link: f.link })).text).toMatch(/^REJECTED: no board at /);
            expect((await agent.call('get_board', { board: f.board })).isError).toBe(true);
            expect((await agent.call('create_node', { board: f.board, label: 'Forbidden', sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false })).isError).toBe(true);
          } finally { await agent.client.close(); }
        }
        expect(await f.http.sqlAs(owner!, `SELECT * FROM agent_grant WHERE board_id = ${f.board}`)).toHaveLength(0);
        expect(await f.http.sqlAs(owner!, `SELECT * FROM node WHERE board_id = ${f.board}`)).toHaveLength(0);
      });

      for (const revoke of ['downgrade', 'remove'] as const) {
        it.skipIf(!owner)(`revokes an active workspace agent after ${revoke}, including attempted re-delegation`, async () => {
          const f = await workspaceBoard(revoke);
          const ada = await connect('tok_ada'), bob = await connect('tok_bob');
          try {
            expect(JSON.parse((await ada.call('start_session', { link: f.link })).text).id).toBe(Number(f.board));
            expect(JSON.parse((await bob.call('start_session', { link: f.link })).text).id).toBe(Number(f.board));
            expect((await bob.call('create_node', { board: f.board, label: 'Before revocation', sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false })).isError).toBe(false);
            const agentId = identityFromClaims(`${base}/agent-id`, 'agent:user_bob');
            expect(await f.http.sqlAs(owner!, `SELECT * FROM agent_grant WHERE board_id = ${f.board} AND agent = 0x${agentId}`)).toHaveLength(1);
            if (revoke === 'downgrade') {
              await f.http.callAs(f.ada, 'set_workspace_board_member', [BigInt(f.board), identityArg(f.bobIdentity), 'viewer']);
              // The stored delegation is insufficient without the person's current edit permission.
              expect(await f.http.sqlAs(owner!, `SELECT * FROM agent_grant WHERE board_id = ${f.board} AND agent = 0x${agentId}`)).toHaveLength(1);
            } else {
              await f.http.callAs(f.ada, 'set_workspace_member', [f.workspaceId, identityArg(f.bobIdentity), '']);
              expect(await f.http.sqlAs(owner!, `SELECT * FROM agent_grant WHERE board_id = ${f.board} AND agent = 0x${agentId}`)).toHaveLength(0);
            }
            expect((await bob.call('get_board', { board: f.board })).isError).toBe(true);
            expect((await bob.call('create_node', { board: f.board, label: 'After revocation', sublabel: '', x: 240, y: 0, w: 160, h: 64, token: 'ink', focal: false })).isError).toBe(true);
            expect((await bob.call('start_session', { link: f.link })).text).toMatch(/^REJECTED: no board at /);
            expect((await bob.call('get_board', { board: f.board })).isError).toBe(true);
            expect((await ada.call('create_node', { board: f.board, label: 'Owner still edits', sublabel: '', x: 480, y: 0, w: 160, h: 64, token: 'ink', focal: false })).isError).toBe(false);
            expect((await f.http.sqlAs(owner!, `SELECT * FROM node WHERE board_id = ${f.board}`)).map(n => n.label).sort()).toEqual(['Before revocation', 'Owner still edits']);
          } finally { await Promise.all([ada.client.close(), bob.client.close()]); }
        });
      }

      it('draws on its own board through every drawing tool', async () => {
        const { client, call } = await connect('tok_ada');
        expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual([...TOOL_NAMES].sort());

        const name = `main-${era}`;
        const started = JSON.parse((await call('start_session', { name })).text);
        expect(started).toMatchObject({ board: name, session: false });
        const boardLink = new URL(started.url);
        expect(boardLink.origin).toBe(env.APP_ORIGIN);
        // the canonical link is the board's slug (#b=), as the canvas shows it
        expect(boardLink.searchParams.get('boardId')).toBeNull();
        expect(new URLSearchParams(boardLink.hash.slice(1)).get('b')).toMatch(/^[0-9a-f]{20}$/);
        expect(boardLink.searchParams.get('db')).toBeNull(); // APP_ORIGIN serves DB_NAME, so its links never name it
        // and that link opens the same board
        expect(JSON.parse((await call('start_session', { link: started.url })).text).id).toBe(started.id);
        // a second call (a retry, or tomorrow's session) finds the same board
        expect(JSON.parse((await call('start_session', { name })).text).id).toBe(started.id);
        const board = String(started.id);

        const node = async (label: string, x: number) => {
          const r = await call('create_node', { board, label, sublabel: '', x, y: 0, w: 160, h: 64, token: 'ink', focal: false });
          expect(r.isError, r.text).toBe(false);
          return /committed id=(\d+)/.exec(r.text)![1];
        };
        const a = await node('Gateway', 0);
        const b = await node('Store', 240);
        const created = (await call('create_edge', { board, fromNode: a, toNode: b, label: 'writes', evidence: 'import' })).text;
        expect(created).toMatch(new RegExp(`^committed id=\\d+ board=${name}$`));
        const edge = /committed id=(\d+)/.exec(created)![1];
        expect((await call('set_edge_latency', { board, edgeId: edge, latencyMs: 38.5, source: 'prod' })).text).toBe(`committed board=${name}`);
        expect((await call('set_edge_latency', { board, edgeId: edge, latencyMs: 700_000, source: 'prod' })).text).toMatch(/^REJECTED.*latencyMs must be at most 600000/);
        expect((await call('move_node', { board, nodeId: a, x: 8, y: 8 })).text).toBe(`committed board=${name}`);
        expect((await call('update_node', { board, nodeId: a, label: 'API gateway' })).isError).toBe(false);
        expect((await call('resize_node', { board, nodeId: a, x: 8, y: 8, w: 200, h: 68 })).isError).toBe(false);
        expect((await call('set_node_doc', { board, nodeId: b, doc: 'Holds the rows.' })).isError).toBe(false);
        expect((await call('hide_node', { board, nodeId: b, hidden: true, set: 'storage' })).isError).toBe(false);
        expect((await call('set_selection', { board, nodeIds: [a] })).text).toBe(`committed board=${name}`);

        const chart = await call('create_chart', {
          board, title: 'Latency', subtitle: 'ms', x: 0, y: 200, w: 320, h: 200, type: 'bars', csv: 'route,p50\n/a,12\n/b,30', source: 'agent: bench @ 1a2b3c4',
        });
        expect(chart.isError, chart.text).toBe(false);
        const chartId = /committed id=(\d+)/.exec(chart.text)![1];
        expect(JSON.parse((await call('get_chart', { board, nodeId: chartId })).text)).toMatchObject({ type: 'bars', csv: 'route,p50\n/a,12\n/b,30' });
        expect((await call('set_chart_data', { board, nodeId: chartId, csv: 'route,p50\n/a,11\n/b,29', source: 'agent: bench @ 2b3c4d5' })).isError).toBe(false);
        expect((await call('describe_charts', { type: 'bars' })).isError).toBe(false);

        const snap = JSON.parse((await call('get_board', { board })).text);
        expect(snap.board).toBe(name);
        expect(snap.nodes.map((n: { label: string }) => n.label).sort()).toEqual(['API gateway', 'Latency', 'Store']);
        expect(snap.nodes.find((n: { label: string }) => n.label === 'Store')).toMatchObject({ hidden: true, hideSet: 'storage', doc: 'Holds the rows.' });
        expect(snap.edges).toHaveLength(1);
        expect(snap.edges[0]).toMatchObject({ latencyMs: 38.5, latencySource: 'prod' });
        const spans = [
          { id: 'req', node: a, startMs: 0, durationMs: 40 },
          { id: 'write', parent: 'req', node: b, startMs: 5, durationMs: 20, status: 'error' },
        ];
        expect((await call('play_trace', { board, source: 'local', title: 'GET /', spans })).text).toBe(`committed trace: 2 spans, 40ms board=${name}`);
        expect((await call('play_trace', { board, source: 'prod', spans: [{ id: 'r', node: '999999', startMs: 0, durationMs: 1 }] })).text).toMatch(/^REJECTED.*node 999999 is not on this board/);
        if (owner) {
          const [row] = await dbHttp(url!, db!).sqlAs(owner, `SELECT * FROM trace_playback WHERE board_id = ${board}`);
          expect(row).toMatchObject({ source: 'local', title: 'GET /', seq: 1 });
          expect(JSON.parse(String(row.spans))).toEqual([
            { id: 'req', parent: null, node: a, startMs: 0, durationMs: 40, status: 'ok' },
            { id: 'write', parent: 'req', node: b, startMs: 5, durationMs: 20, status: 'error' },
          ]);
        }

        const edgeId = snap.edges[0].id;
        expect((await call('delete_edge', { board, edgeId })).text).toBe(`committed board=${name}`);
        expect((await call('delete_node', { board, nodeId: b })).text).toBe(`committed board=${name}`);
        await client.close();
      });

      it('relays module rules verbatim, and refuses what the Worker knows is wrong', async () => {
        const { client, call } = await connect('tok_ada');
        const board = String(JSON.parse((await call('start_session', { name: `rules-${era}` })).text).id);
        const off = await call('create_node', { board, label: 'Off grid', sublabel: '', x: 3, y: 0, w: 160, h: 64, token: 'ink', focal: false });
        expect(off).toEqual({ isError: true, text: `REJECTED: grid rule: x = 3 is not divisible by 4; all coordinates and dimensions must sit on the 4px grid board=rules-${era}` });
        expect((await call('move_node', { board, nodeId: '9007199254740993', x: 0, y: 0 })).text).toBe(
          'REJECTED: id 9007199254740993 is too large. Nothing was written. Call get_board for current ids.'
        );
        expect((await call('get_board', { board: '999999' })).text).toMatch(/^REJECTED: board 999999 not found\. Nothing was written\./);
        // source: evidence is read from the user's checkout, so it needs a session board
        expect((await call('create_edge', { board, fromNode: '1', toNode: '2', label: 'x', evidence: 'source:src/a.ts:3' })).text).toBe(
          `REJECTED: board "rules-${era}" has no session for this checkout. Nothing was written. Call start_session from inside your project to open a board with code refs.`
        );
        expect((await call('add_code_ref', { board, targetKind: 'node', targetId: '1', path: 'a.ts', symbol: 'f' })).text).toBe(
          `REJECTED: board "rules-${era}" has no session for this checkout. Nothing was written. Call start_session from inside your project to open a board with code refs.`
        );
        await client.close();
      });

      it("keeps accounts apart: another account's board and nodes are not found", async () => {
        const ada = await connect('tok_ada');
        const bob = await connect('tok_bob');
        const adaBoard = JSON.parse((await ada.call('start_session', { name: `shared-name-${era}` })).text);
        const bobBoard = JSON.parse((await bob.call('start_session', { name: `shared-name-${era}` })).text);
        expect(bobBoard.id).not.toBe(adaBoard.id);
        const r = await ada.call('create_node', { board: String(adaBoard.id), label: 'Ada only', sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false });
        const adaNode = /committed id=(\d+)/.exec(r.text)![1];
        // Bob's own board id with Ada's node: not on that board, nothing written
        expect((await bob.call('move_node', { board: String(bobBoard.id), nodeId: adaNode, x: 40, y: 40 })).text).toBe(
          `REJECTED: node ${adaNode} not found on board "shared-name-${era}". Nothing was written. Call get_board for current ids.`
        );
        expect((await bob.call('get_board', { board: String(adaBoard.id) })).text).toMatch(new RegExp(`^REJECTED: board ${adaBoard.id} not found`));
        // An edge from Bob's board to Ada's node: not found on his board, and her board's id is never named
        const own = /committed id=(\d+)/.exec((await bob.call('create_node', { board: String(bobBoard.id), label: 'Bob only', sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false })).text)![1];
        expect((await bob.call('create_edge', { board: String(bobBoard.id), fromNode: own, toNode: adaNode, label: 'x', evidence: 'import' })).text).toBe(
          `REJECTED: node ${adaNode} not found on board "shared-name-${era}". Nothing was written. Call get_board for current ids.`
        );
        expect((await bob.call('start_session', { link: adaBoard.url })).text).toBe(
          `REJECTED: no board at ${adaBoard.url}. Nothing was written. Check the link, or call start_session with a name to open your own board.`
        );
        await ada.client.close();
        await bob.client.close();
      });

      it.skipIf(!owner)('branches a factual snapshot into an editable proposal; the snapshot stays read-only', async () => {
        const { client, call } = await connect('tok_ada');
        const http = dbHttp(url!, db!);
        const sha = '0123456789abcdef0123456789abcdef01234567';
        const key = `history-${era}`;
        // The history and its snapshot as the importer would leave them: the agent owns the history, the service publishes.
        await http.callAs(await mint(env, 'agent:user_ada'), 'create_architecture_history', [`repo ${era}`, 'https://github.com/example/repo', JSON.stringify([{ ref: 'main', sha }]), key]);
        const [history] = await http.sqlAs(owner!, `SELECT * FROM architecture_history WHERE request_key = '${key}'`);
        const graph = {
          nodes: [{ key: 'js:a.ts', label: 'a', sublabel: '', kind: 'service' }, { key: 'js:b.ts', label: 'b', sublabel: '', kind: 'service' }],
          edges: [{ from: 'js:a.ts', to: 'js:b.ts', label: 'uses', relation: 'import', evidence: 'import' }],
          files: ['a.ts', 'b.ts'],
        };
        await http.callAs(await mint(env, 'service:mcp'), 'publish_architecture_snapshot', [BigInt(history.id as bigint), 0, 'main', sha, JSON.stringify(graph)]);
        const [fact] = await http.sqlAs(owner!, `SELECT * FROM architecture_version WHERE history_id = ${history.id}`);
        const snapshot = String(fact.board_id);

        const first = await call('create_branch', { board: snapshot, name: `feature-${era}` });
        expect(first.isError, first.text).toBe(false);
        const made = JSON.parse(first.text);
        expect(made).toMatchObject({ board: `feature-${era}`, base: Number(snapshot) });
        expect(made.id).not.toBe(Number(snapshot));
        expect(new URL(made.url).origin).toBe(env.APP_ORIGIN);
        // a retry finds the same branch
        expect(JSON.parse((await call('create_branch', { board: snapshot, name: `feature-${era}` })).text).id).toBe(made.id);
        const branch = String(made.id);
        expect(await http.sqlAs(owner!, `SELECT * FROM node WHERE board_id = ${branch}`)).toHaveLength(2);
        expect((await call('create_node', { board: branch, label: 'Cache', sublabel: '', x: 0, y: 240, w: 160, h: 64, token: 'ink', focal: false })).isError).toBe(false);
        expect((await call('create_node', { board: snapshot, label: 'Cache', sublabel: '', x: 0, y: 240, w: 160, h: 64, token: 'ink', focal: false })).text).toMatch(
          /^REJECTED: .*factual snapshots reject graph edits/
        );
        // a branch of a branch: the base must be a snapshot
        expect((await call('create_branch', { board: branch, name: `feature-${era}-2` })).text).toMatch(/^REJECTED: /);
        await client.close();
      });

      it('branches a plain board and submits it', async () => {
        const { client, call } = await connect('tok_ada');
        const started = JSON.parse((await call('start_session', { name: `plain-${era}` })).text);
        const board = String(started.id);
        await call('create_node', { board, label: 'A', sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false });
        const made = JSON.parse((await call('create_branch', { board, name: `plain-${era}-b` })).text);
        expect(made.base).toBe(Number(board));
        expect((await call('submit_branch', { board: String(made.id) })).text).toBe(`committed board=plain-${era}-b`);
        expect(JSON.parse((await call('get_board', { board: String(made.id) })).text).architecture).toMatchObject({ status: 'submitted', base: `plain-${era}` });
        await client.close();
      });

      it.skipIf(!owner)("opens its person's own board by link, and only theirs", async () => {
        const ada = await connect('tok_ada');
        const bob = await connect('tok_bob');
        const made = JSON.parse((await ada.call('start_session', { name: `browser-${era}` })).text);
        // as if Ada made it in the browser: hers, with no grant for her agent
        await dbHttp(url!, db!).sqlAs(owner!, `DELETE FROM agent_grant WHERE board_id = ${made.id}`);
        expect((await ada.call('get_board', { board: String(made.id) })).text).toMatch(new RegExp(`^REJECTED: board ${made.id} not found`));
        expect((await bob.call('start_session', { link: made.url })).text).toMatch(/^REJECTED: no board at /);
        expect(JSON.parse((await ada.call('start_session', { link: made.url })).text)).toMatchObject({ id: made.id, url: made.url, session: false });
        expect((await ada.call('get_board', { board: String(made.id) })).isError).toBe(false);
        expect((await bob.call('get_board', { board: String(made.id) })).text).toMatch(new RegExp(`^REJECTED: board ${made.id} not found`));
        // no session and no capture: a flow no code shows is drawn as an agent claim, never as human:
        const board = String(made.id);
        const node = async (label: string, x: number) =>
          /committed id=(\d+)/.exec((await ada.call('create_node', { board, label, sublabel: '', x, y: 0, w: 160, h: 64, token: 'ink', focal: false })).text)![1];
        const [siem, edr] = [await node('SIEM', 0), await node('EDR', 240)];
        expect((await ada.call('create_edge', { board, fromNode: edr, toNode: siem, label: 'alerts', evidence: 'agent:user described the topology' })).text).toMatch(/^committed id=\d+ board=/);
        expect((await ada.call('create_edge', { board, fromNode: siem, toNode: edr, label: 'forged', evidence: 'human:Ada' })).text).toMatch(/^REJECTED: evidence rule: agents cannot use human: evidence/);
        expect((await ada.call('create_edge', { board, fromNode: siem, toNode: edr, label: 'bare', evidence: 'agent: ' })).text).toMatch(/^REJECTED: evidence rule: 'agent:' must be followed by what the edge rests on/);
        const { edges } = JSON.parse((await ada.call('get_board', { board })).text);
        expect(edges.map((e: { label: string; evidence: string }) => [e.label, e.evidence])).toEqual([['alerts', 'agent:user described the topology']]);
        await ada.client.close();
        await bob.client.close();
      });

      it.skipIf(!owner)('opens a board by the link its Share control copies: edits its own, only reads another', async () => {
        const ada = await connect('tok_ada');
        const bob = await connect('tok_bob');
        const made = JSON.parse((await ada.call('start_session', { name: `share-${era}` })).text);
        const http = dbHttp(url!, db!);
        await http.sqlAs(owner!, `DELETE FROM agent_grant WHERE board_id = ${made.id}`);
        const token = newShareToken();
        // Ada shares it from the canvas: her agent stands in for her browser while it owns the board
        const ownerIs = (who: string) => http.sqlAs(owner!, `UPDATE board_grant SET grantee = 0x${who} WHERE board_id = ${made.id} AND role = 'owner'`);
        await ownerIs(identityFromClaims(`${base}/agent-id`, 'agent:user_ada'));
        await http.callAs(await mint(env, 'agent:user_ada'), 'set_link_share', [BigInt(made.id), 'view', token]);
        await ownerIs(identityFromClaims(env.OIDC_ISSUER, 'user_ada'));
        const link = shareHref(env.APP_ORIGIN, db!, token);
        const node = { label: 'Shared', sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false };
        expect(JSON.parse((await ada.call('start_session', { link })).text)).toMatchObject({ id: made.id });
        expect((await ada.call('create_node', { board: String(made.id), ...node })).isError).toBe(false);
        expect(JSON.parse((await bob.call('start_session', { link })).text)).toMatchObject({ id: made.id });
        expect((await bob.call('create_node', { board: String(made.id), ...node })).isError).toBe(true);
        expect((await bob.call('start_session', { link: shareHref(env.APP_ORIGIN, db!, newShareToken()) })).text).toMatch(/^REJECTED: no board at /);
        await ada.client.close();
        await bob.client.close();
      });
    });
  }

  it('a repeated create inside 30 s writes one node', async () => {
    const opts = { requestInit: { headers: { authorization: 'Bearer tok_ada' } } };
    const client = new ClientV1({ name: 'test', version: '1' });
    await client.connect(new TransportV1(new URL(`${base}/mcp`), opts));
    const board = String(JSON.parse(((await client.callTool({ name: 'start_session', arguments: { name: 'dedupe' } })) as { content: { text: string }[] }).content[0].text).id);
    const args = { board, label: 'Once', sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false };
    const first = ((await client.callTool({ name: 'create_node', arguments: args })) as { content: { text: string }[] }).content[0].text;
    const again = ((await client.callTool({ name: 'create_node', arguments: args })) as { content: { text: string }[] }).content[0].text;
    expect(again).toMatch(/ \(same call \d+ s ago; nothing new written\)$/);
    expect(again.replace(/ \(same call \d+ s ago; nothing new written\)$/, '')).toBe(first);
    const snap = JSON.parse(((await client.callTool({ name: 'get_board', arguments: { board } })) as { content: { text: string }[] }).content[0].text);
    expect(snap.nodes.filter((n: { label: string }) => n.label === 'Once')).toHaveLength(1);
    await client.close();
  });

  it.skipIf(!owner)("the Worker linked each agent to its owner's browser identity (Decision 24)", async () => {
    const rows = await dbHttp(url!, db!).sqlAs(owner!, 'SELECT * FROM agent_link');
    const hex = (cell: unknown) => String(Array.isArray(cell) ? cell[0] : cell).replace(/^0x/, '').toLowerCase();
    const links = rows.map(r => [hex(r.agent), hex(r.owner)]);
    expect(links).toContainEqual([identityFromClaims(`${base}/agent-id`, 'agent:user_ada'), identityFromClaims(env.OIDC_ISSUER, 'user_ada')]);
  });

  it('the agent joined as "agent of <name>", with its own identity', async () => {
    const http = dbHttp(url!, db!);
    const token = await mint(env, 'agent:user_ada');
    const rows = await http.sqlAs(token, 'SELECT * FROM visible_participant');
    const me = identityFromClaims(`${base}/agent-id`, 'agent:user_ada');
    const row = rows.find(r => String((r.identity as unknown[])[0] ?? r.identity).replace(/^0x/, '') === me);
    expect(row).toMatchObject({ display_name: 'agent of Ada', kind: 'agent' });
  });

  it.skipIf(!owner)('the cron reads the database load as the service (RC-549)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await dbLoad(database(env, () => mint(env, SERVICE_SUBJECT)), env);
    const line = JSON.parse(log.mock.calls.map(c => String(c[0])).find(l => l.includes('"db.load"'))!);
    log.mockRestore();
    expect(line.participants).toBeGreaterThan(0);
    expect(line.agents).toBeGreaterThan(0);
  });

  it.skipIf(!process.env.MCP_ORIGIN)('a hosted agent keeps one quiet presence row and its selection across HTTP calls', async () => {
    const opts = { requestInit: { headers: { authorization: 'Bearer tok_ada' } } };
    const client = new ClientV1({ name: 'test', version: '1' });
    await client.connect(new TransportV1(new URL(`${base}/mcp`), opts));
    const text = async (name: string, args: Record<string, unknown>) =>
      ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text;
    const board = String(JSON.parse(await text('start_session', { name: 'presence' })).id);
    const nodeId = /committed id=(\d+)/.exec(await text('create_node', { board, label: 'Here', sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false }))![1];
    await text('set_selection', { board, nodeIds: [nodeId] });
    await text('get_board', { board }); // more HTTP calls after the selection
    await text('get_board', { board });
    const http = dbHttp(url!, db!);
    const token = await mint(env, 'agent:user_ada');
    const me = identityFromClaims(`${base}/agent-id`, 'agent:user_ada');
    const hex = (cell: unknown) => String(Array.isArray(cell) ? cell[0] : cell).replace(/^0x/, '').toLowerCase();
    const selection = (await http.sqlAs(token, `SELECT * FROM visible_selection WHERE board_id = ${board}`)).find(r => hex(r.identity) === me);
    expect(selection?.node_ids).toEqual([Number(nodeId)]);
    const participant = (await http.sqlAs(token, 'SELECT * FROM visible_participant')).find(r => hex(r.identity) === me);
    expect(participant).toMatchObject({ kind: 'agent', connections: 0 });
    await client.close();
  });

  describe('code refs and checkpoints on captures from the real helper', () => {
    const helper = new URL('../../helper/dist/redcrayon.mjs', import.meta.url).pathname;
    const GIT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    let repo: string;
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...GIT }, stdio: 'pipe' }).toString().trim();
    const write = (rel: string, text: string) => {
      mkdirSync(join(repo, rel, '..'), { recursive: true });
      writeFileSync(join(repo, rel), text);
    };
    // The helper as an agent runs it: one line on stdout, the upload to our origin (served by
    // this process, so the helper runs asynchronously).
    const capture = async (cwd: string, ...args: string[]) =>
      (await promisify(execFile)('node', [helper, 'capture', ...args], { cwd, env: { ...process.env, ...GIT, REDCRAYON_ORIGIN: base } })).stdout.trim();

    beforeAll(() => {
      repo = realpathSync(mkdtempSync(join(tmpdir(), 'rc-hosted-')));
      git(repo, 'init', '-q', '-b', 'main');
      write('src/limiter.ts', 'export class Limiter {\n  allow(used: number): boolean {\n    return used < 10;\n  }\n}\n');
      write('src/server.ts', "import { Limiter } from './limiter';\nexport const handle = (n: number) => new Limiter().allow(n);\n");
      write('src/keys.ts', "export const awsKey = 'AKIAABCDEFGHIJKLMNOP';\n");
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'base');
      git(repo, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
    });

    it.skipIf(!owner)('start_session, add_code_ref, a cited edge and mark_checkpoint keep the local guarantees', async () => {
      // Ada keeps code snippets on her boards (RC-690), as if she turned it on in the dashboard. There is no
      // browser token here, so a stand-in opts in and the database owner moves the row to her.
      const http = dbHttp(url!, db!);
      const ada = identityFromClaims(env.OIDC_ISSUER, 'user_ada');
      await http.callAs(await mint(env, 'guest:consent'), 'set_code_consent', [true]);
      await http.sqlAs(owner!, `UPDATE code_consent SET key = 'user:${ada}', subject = '${ada}' WHERE key = 'user:${identityFromClaims(`${base}/agent-id`, 'guest:consent')}'`);
      const opts = { requestInit: { headers: { authorization: 'Bearer tok_ada' } } };
      const client = new ClientV2({ name: 'test', version: '1' });
      await client.connect(new TransportV2(new URL(`${base}/mcp`), opts) as never);
      const call = async (name: string, args: Record<string, unknown>) => {
        const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        return { text: res.content[0].text, isError: res.isError === true };
      };

      const started = JSON.parse((await call('start_session', { name: 'hosted', capture: await capture(repo, 'start') })).text);
      expect(started).toMatchObject({ board: 'hosted', session: true, checkpoint: 0, repoRoot: repo, baseSha: git(repo, 'rev-parse', 'HEAD') });
      const board = String(started.id);
      // the helper sent origin as https, and the board holds it: nothing pushed, nothing dirty yet
      const remote = async () => (await http.sqlAs(owner!, `SELECT * FROM session_remote WHERE board_id = ${board}`))[0];
      expect(await remote()).toMatchObject({ remote_url: 'https://github.com/o/r.git', pushed_head: '', dirty_paths: [] });
      const node = async (label: string) => /committed id=(\d+)/.exec((await call('create_node', { board, label, sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false })).text)![1];
      const limiter = await node('Limiter');
      const server = await node('Server');

      const ref = await call('add_code_ref', { board, targetKind: 'node', targetId: limiter, path: 'src/limiter.ts', symbol: 'Limiter.allow', capture: await capture(repo, 'ref', 'src/limiter.ts', '--board', board) });
      expect(ref).toEqual({ isError: false, text: expect.stringMatching(/^committed id=\d+ src\/limiter\.ts:2-4 board=hosted$/) });
      const edge = await call('create_edge', { board, fromNode: server, toNode: limiter, label: 'uses', evidence: 'source:src/server.ts:1', capture: await capture(repo, 'cite', 'src/server.ts', '--board', board) });
      expect(edge).toEqual({ isError: false, text: expect.stringMatching(/^committed id=\d+ board=hosted$/) });
      // Her board keeps code: the edge holds its cited line, and its hash too.
      const http2 = dbHttp(url!, db!);
      const edgeId = /id=(\d+)/.exec(edge.text)![1];
      const hashes = () => http2.sqlAs(owner!, `SELECT * FROM edge_evidence_hash WHERE board_id = ${board}`);
      expect((await http2.sqlAs(owner!, `SELECT * FROM edge WHERE id = ${edgeId}`))[0]).toMatchObject({ evidence_snippet: "import { Limiter } from './limiter';", evidence_status: 'ok' });
      expect(await hashes()).toHaveLength(1);
      // Opted out, the same citation keeps its hash and no text.
      await http2.sqlAs(owner!, `UPDATE code_consent SET store_code = false WHERE key = 'user:${ada}'`);
      const bare = await call('apply_board', { board, edges: [{ fromNode: limiter, toNode: server, label: 'used by', evidence: 'source:src/server.ts:2', capture: await capture(repo, 'cite', 'src/server.ts', '--board', board) }] });
      await http2.sqlAs(owner!, `UPDATE code_consent SET store_code = true WHERE key = 'user:${ada}'`);
      expect(bare.isError, bare.text).toBe(false);
      const bareId = JSON.parse(bare.text).edges[0];
      expect(bareId).toMatch(/^\d+$/);
      expect((await http2.sqlAs(owner!, `SELECT * FROM edge WHERE id = ${bareId}`))[0]).toMatchObject({ evidence_snippet: '', evidence_status: 'ok' });
      expect(await hashes()).toHaveLength(2);

      // The ref's lines shift and its body changes: the checkpoint follows the symbol, and the edit is covered by it.
      write('src/limiter.ts', '// Token limits.\nexport class Limiter {\n  allow(used: number): boolean {\n    return used < 12;\n  }\n}\n');
      const ck = await capture(repo, 'checkpoint', '--board', board, '--base', started.baseSha);
      const res = JSON.parse((await call('mark_checkpoint', { board, capture: ck })).text);
      expect(res).toMatchObject({ board: 'hosted', checkpoint: 1, reanchor: { drifted: 1, stale: [] }, citedPaths: ['src/limiter.ts', 'src/server.ts'] });
      // the one changed file holds the ok ref, so it is covered
      expect(res.coverage).toMatchObject({ changed: 1, uncovered: [], deleted: [] });
      // the checkpoint recorded that the cited file is edited and HEAD is not on an upstream
      expect(await remote()).toMatchObject({ remote_url: 'https://github.com/o/r.git', pushed_head: '', dirty_paths: ['src/limiter.ts'] });
      const snap = JSON.parse((await call('get_board', { board })).text);
      expect(snap.nodes.find((n: { label: string }) => n.label === 'Limiter').refs[0]).toMatchObject({ symbol: 'Limiter.allow', startLine: 3, endLine: 5, status: 'ok' });

      // A client re-sending the same call gets the first answer, not a refusal; a capture reused for another call is refused.
      const again = await call('mark_checkpoint', { board, capture: ck });
      expect(again.text).toMatch(/^\{[^]*\} \(same call \d+ s ago; nothing new written\)$/);
      expect((await call('mark_checkpoint', { board, capture: ck, exclude: [{ reason: 'docs', glob: 'docs/**' }] })).text).toBe(
        `REJECTED: capture ${ck} expired or was already used (a capture works once, within 10 minutes). Nothing was written. Run the capture again and pass the new id.`
      );
      // A capture is bound to its call.
      const forServer = await capture(repo, 'ref', 'src/server.ts', '--board', board);
      expect((await call('add_code_ref', { board, targetKind: 'node', targetId: limiter, path: 'src/limiter.ts', symbol: 'Limiter', capture: forServer })).text).toBe(
        `REJECTED: capture ${forServer} was made for add_code_ref src/server.ts, not add_code_ref src/limiter.ts. Nothing was written. Run the capture for this call and pass the new id.`
      );
      // No snippet holding a secret is ever stored.
      const secret = await call('add_code_ref', { board, targetKind: 'node', targetId: limiter, path: 'src/keys.ts', symbol: 'awsKey', capture: await capture(repo, 'ref', 'src/keys.ts', '--board', board) });
      // The path was registered before the snippet was read, so the text says an earlier write stands; no ref holds the secret.
      expect(secret.text).toBe('REJECTED: src/keys.ts:1 looks like a secret (AWS access key). An earlier write in this call stands; nothing after it was written. Cite lines without secrets.');
      const refs = JSON.parse((await call('get_board', { board })).text).nodes.flatMap((n: { refs: { symbol: string }[] }) => n.refs);
      expect(refs.map((r: { symbol: string }) => r.symbol)).not.toContain('awsKey');

      // A second checkout of the same branch name gets "hosted (2)", never a rejection.
      const other = realpathSync(mkdtempSync(join(tmpdir(), 'rc-hosted-wt-')));
      git(repo, 'worktree', 'add', '-q', '--detach', join(other, 'wt'));
      const second = JSON.parse((await call('start_session', { name: 'hosted', capture: await capture(join(other, 'wt'), 'start') })).text);
      expect(second).toMatchObject({ board: 'hosted (2)', session: true, note: 'a board named hosted already tracks another checkout; this one is hosted (2)' });
      // and the first checkout re-adopts its own board
      expect(JSON.parse((await call('start_session', { name: 'hosted', capture: await capture(repo, 'start') })).text).id).toBe(started.id);
      await client.close();
    });

    it("re-adopts this checkout's board when another checkout's board has the same name", async () => {
      const opts = { requestInit: { headers: { authorization: 'Bearer tok_ada' } } };
      const client = new ClientV2({ name: 'test', version: '1' });
      await client.connect(new TransportV2(new URL(`${base}/mcp`), opts) as never);
      const start = async (name: string, cwd: string) =>
        JSON.parse(((await client.callTool({ name: 'start_session', arguments: { name, capture: await capture(cwd, 'start') } })) as { content: { text: string }[] }).content[0].text);
      const other = realpathSync(mkdtempSync(join(tmpdir(), 'rc-hosted-dup-')));
      git(repo, 'worktree', 'add', '-q', '--detach', join(other, 'wt'));
      // the other checkout's board first, so a pick by name alone finds it; an owner rename gives both one name
      const first = await start('dup-other', join(other, 'wt'));
      const mine = await start('dup', repo);
      await dbHttp(url!, db!).sqlAs(owner!, `UPDATE board SET name = 'dup' WHERE id = ${first.id}`);
      expect(await start('dup', repo)).toMatchObject({ id: mine.id, board: 'dup', session: true, repoRoot: repo });
      await client.close();
    });

    it('/facts refuses browsers and has no way to read a capture back', async () => {
      expect((await fetch(`${base}/facts`, { method: 'POST', headers: { origin: 'https://evil.test' }, body: '{}' })).status).toBe(403);
      const id = await capture(repo, 'start');
      expect((await fetch(`${base}/facts/${id}`)).status).toBe(404);
    });
  });

  it('401 without a token', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
});
