import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

export async function withStack(use: (stack: {
  url: string;
  databaseUrl: string;
  databaseName: string;
  /** A signed browser session token; claims override the payload, and an undefined value drops that claim. */
  accountToken(claims?: Record<string, unknown>): string;
  /** Native dashboard with either the signed-in fixture or the real generic OIDC adapter. */
  startDashboard(provider?: 'fixture' | 'oidc'): Promise<string>;
  oidcExchanges(): number;
  /** A reducer call as the given token's identity; throws on refusal. */
  callReducer(token: string, reducer: string, args: unknown[]): Promise<void>;
  /** A fresh database-minted identity, as the stdio agents get. */
  mintIdentity(): Promise<{ identity: string; token: string }>;
  /** A minted identity listed in service_account. */
  serviceIdentity(label: string): Promise<{ identity: string; token: string }>;
  /** SQL as the database owner. */
  sql(query: string): Promise<Record<string, unknown>[]>;
  /** Publish the same module again, keeping its data, as a production deploy does. */
  republish(): Promise<void>;
  prepareSchemaUpgrade(): Promise<{
    publishModule(): Promise<void>;
    deployClient(): Promise<void>;
    restorePreviousClient(): Promise<void>;
    preservePublicEdge(): Promise<void>;
    readEdges(): Promise<Record<string, unknown>[]>;
  }>;
}) => Promise<void>, { clientEnv = {}, moduleEnv = {} }: { clientEnv?: Record<string, string>; moduleEnv?: Record<string, string> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'redcrayon-e2e-'));
  const dbPort = await freePort();
  const appPort = await freePort();
  const url = `http://127.0.0.1:${appPort}/`;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e', alg: 'ES256', use: 'sig' };
  const codes = new Map<string, { redirect: string; challenge: string; nonce: string }>();
  let exchanges = 0;
  const issueToken = (subject: string, extra: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64({ alg: 'ES256', typ: 'JWT', kid: jwk.kid })}.${b64({ iss: browserIssuer, sub: subject, sid: `sess_${randomUUID()}`, azp: url.slice(0, -1), iat: now, exp: now + 3600, ...extra })}`;
    return `${input}.${sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  const issuer = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    const request = new URL(req.url ?? '/', 'http://issuer.test');
    if (request.pathname === '/browser/authorize') {
      const redirect = request.searchParams.get('redirect_uri') ?? '';
      const challenge = request.searchParams.get('code_challenge') ?? '';
      const nonce = request.searchParams.get('nonce') ?? '';
      if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(redirect) || request.searchParams.get('client_id') !== 'redcrayon-e2e' || request.searchParams.get('code_challenge_method') !== 'S256' || !challenge || !nonce) {
        res.writeHead(400).end('Invalid authorization request'); return;
      }
      const code = randomUUID();
      codes.set(code, { redirect, challenge, nonce });
      const back = new URL(redirect);
      back.searchParams.set('code', code);
      back.searchParams.set('state', request.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.href }).end(); return;
    }
    if (request.pathname === '/browser/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const code = params.get('code') ?? '';
      const pending = codes.get(code);
      codes.delete(code);
      const challenge = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url');
      if (!pending || params.get('grant_type') !== 'authorization_code' || params.get('client_id') !== 'redcrayon-e2e' || params.get('redirect_uri') !== pending.redirect || challenge !== pending.challenge) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' })); return;
      }
      exchanges++;
      const token = issueToken('generic-oidc-user', { aud: 'redcrayon-e2e', nonce: pending.nonce, name: 'OIDC architect', email: 'architect@example.test' });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id_token: token, access_token: token, token_type: 'Bearer', expires_in: 3600 })); return;
    }
    const body = request.pathname === '/browser/.well-known/openid-configuration'
      ? { issuer: browserIssuer, jwks_uri: `${browserIssuer}/jwks.json`, authorization_endpoint: `${browserIssuer}/authorize`, token_endpoint: `${browserIssuer}/token`, id_token_signing_alg_values_supported: ['ES256'], response_types_supported: ['code'], subject_types_supported: ['public'], code_challenge_methods_supported: ['S256'] }
      : request.pathname === '/browser/jwks.json' ? { keys: [jwk] } : null;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  issuer.listen(0, '127.0.0.1');
  await once(issuer, 'listening');
  const issuerPort = (issuer.address() as { port: number }).port;
  const browserIssuer = `http://127.0.0.1:${issuerPort}/browser`;
  const env = {
    ...process.env,
    STDB_TEST_ROOT: join(root, 'database'), STDB_TEST_PORT: String(dbPort),
    STDB_TEST_DB: 'redcrayon-e2e', STDB_TEST_ISSUER_PORT: String(issuerPort),
    BROWSER_ISSUER: browserIssuer, APP_ORIGINS: url.slice(0, -1), MCP_ORIGIN: '',
  };
  const logName = `services-${randomUUID()}`;
  const logPath = join(repo, `e2e/test-results/${logName}.log`);
  await mkdir(join(repo, 'e2e/test-results'), { recursive: true });
  const log = createWriteStream(logPath);
  const start = (command: string, args: string[], cwd = repo, extra = {}) => {
    const child = spawn(command, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    return child;
  };
  const run = async (command: string, args: string[], cwd = repo, extra = {}) => {
    const child = start(command, args, cwd, extra);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    // Large describe JSON can still be draining after the child exits.
    const [code] = await once(child, 'close');
    if (code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${code})\n${stdout.slice(-8_000)}\n${stderr.slice(-8_000)}\nFull log: ${logPath}`);
    return stdout;
  };
  let preview: ReturnType<typeof spawn> | undefined;
  const dashboards = new Map<string, { child: ReturnType<typeof spawn>; url: string }>();
  // E2E_CLIENT_CONFIG swaps in another build of the canvas, e.g. one with a different auth provider.
  const buildClient = async (bindings = '') => { await run('pnpm', ['exec', 'vite', 'build', '--config', process.env.E2E_CLIENT_CONFIG ?? '../e2e/vite.config.mjs'], join(repo, 'client'), {
    E2E_ASSETS: join(root, 'assets'), E2E_BINDINGS: bindings,
    VITE_SPACETIME_URI: `ws://127.0.0.1:${dbPort}`,
    VITE_SPACETIME_DB: env.STDB_TEST_DB, VITE_SPACETIME_DB_ALLOWED: '',
    VITE_REQUIRE_AUTH: '', VITE_MCP_URL: '', VITE_DASHBOARD_URL: '', ...clientEnv,
  }); };
  const sql = async (query: string) => {
    const token = await readFile(join(root, 'database/owner-token'), 'utf8');
    const response = await fetch(`http://127.0.0.1:${dbPort}/v1/database/${env.STDB_TEST_DB}/sql`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: query,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Upgrade drill SQL failed (${response.status}): ${body}`);
    const [result] = JSON.parse(body);
    if (!result) return [];
    const columns = result.schema.elements.map((column: { name: string | { some: string } }) => typeof column.name === 'string' ? column.name : column.name.some);
    return result.rows.map((row: unknown[]) => Object.fromEntries(columns.map((column: string, i: number) => [column, row[i]])));
  };
  const publish = (database: string, ...flags: string[]) => run('node', [join(root, 'scripts/module-env.mjs'), 'production', '--',
    'spacetime', '--root-dir', env.STDB_TEST_ROOT, 'publish', '--no-config', '--server', `http://127.0.0.1:${dbPort}`, ...flags, database], join(root, 'module'), moduleEnv);
  const republish = async () => {
    // Never reset retained rows. These are the production publisher's
    // non-destructive approvals, plus an explicit no-delete guard.
    await publish(env.STDB_TEST_DB, '--yes=remote,skip-login,break-clients,migrate', '--delete-data=never');
    // Match publish-module.sh's refresh of persisted sender views.
    const sentinel = '18446744073709551615';
    await sql(`DELETE FROM public_board WHERE board_id = ${sentinel}`);
    await sql(`INSERT INTO public_board (board_id) VALUES (${sentinel})`);
    await sql(`DELETE FROM public_board WHERE board_id = ${sentinel}`);
  };
  const mintIdentity = async (): Promise<{ identity: string; token: string }> => {
    const response = await fetch(`http://127.0.0.1:${dbPort}/v1/identity`, { method: 'POST' });
    if (!response.ok) throw new Error(`identity mint failed (${response.status})`);
    return response.json();
  };
  try {
    // Copy the module so concurrent local tests never rewrite this checkout's issuers.
    await mkdir(join(root, 'scripts'));
    await cp(join(repo, 'module/src'), join(root, 'module/src'), { recursive: true });
    await cp(join(repo, 'module/package.json'), join(root, 'module/package.json'));
    await cp(join(repo, 'module/tsconfig.json'), join(root, 'module/tsconfig.json'));
    await cp(join(repo, 'module/pnpm-lock.yaml'), join(root, 'module/pnpm-lock.yaml'));
    await cp(join(repo, 'scripts/module-env.mjs'), join(root, 'scripts/module-env.mjs'));
    await symlink(join(repo, 'module/node_modules'), join(root, 'module/node_modules'), 'dir');
    await run('bash', ['scripts/stdb-test.sh', 'start']);
    await publish(env.STDB_TEST_DB, '--yes', '--delete-data=always');
    await buildClient();
    preview = start('pnpm', ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(appPort), '--strictPort', '--outDir', join(root, 'assets')], join(repo, 'client'));
    const deadline = Date.now() + 15_000;
    while (true) {
      if (await fetch(url).then(r => r.ok, () => false)) break;
      if (preview.exitCode !== null || Date.now() > deadline) throw new Error(`Canvas did not start; see ${logPath}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await use({
      url,
      databaseUrl: `http://127.0.0.1:${dbPort}`,
      databaseName: env.STDB_TEST_DB,
      oidcExchanges: () => exchanges,
      async startDashboard(provider = 'fixture') {
        const existing = dashboards.get(provider);
        if (existing) return existing.url;
        const dashboardPort = await freePort();
        const dashboardUrl = `http://127.0.0.1:${dashboardPort}`;
        // Each provider gets its own Svelte output and no local environment files.
        // A simultaneous type-check/build of the checkout must not reload browser tests.
        const dashboardRoot = join(root, `dashboard-${provider}`);
        const dashboardWeb = join(dashboardRoot, 'web');
        await mkdir(dashboardWeb, { recursive: true });
        await cp(join(repo, 'web/src'), join(dashboardWeb, 'src'), { recursive: true });
        for (const file of ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'svelte.config.js', 'vite.config.ts', 'adapter.wrangler.jsonc']) {
          await cp(join(repo, 'web', file), join(dashboardWeb, file));
        }
        await symlink(join(repo, 'web/node_modules'), join(dashboardWeb, 'node_modules'), 'dir');
        await symlink(join(repo, 'shared'), join(dashboardRoot, 'shared'), 'dir');
        await symlink(join(repo, 'e2e'), join(dashboardRoot, 'e2e'), 'dir');
        const child = start('pnpm', ['exec', 'vite', 'dev', '--host', '127.0.0.1', '--port', String(dashboardPort), '--strictPort'], dashboardWeb, {
          VITE_AUTH_PROVIDER: provider === 'oidc' ? 'oidc' : '../e2e/auth-provider.mjs',
          VITE_OIDC_ISSUER: browserIssuer, VITE_OIDC_CLIENT_ID: 'redcrayon-e2e',
          VITE_SPACETIME_URI: `ws://127.0.0.1:${dbPort}`, VITE_SPACETIME_DB: env.STDB_TEST_DB,
          VITE_SPACETIME_DB_ALLOWED: '', VITE_CANVAS_URL: url,
          VITE_REQUIRE_AUTH: '', VITE_MCP_URL: '',
        });
        dashboards.set(provider, { child, url: dashboardUrl });
        const deadline = Date.now() + 20_000;
        while (!await fetch(dashboardUrl).then(response => response.ok, () => false)) {
          if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Dashboard did not start; see ${logPath}`);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return dashboardUrl;
      },
      async prepareSchemaUpgrade() {
        // RC-603: reproduce a wire-breaking appended core-view column using
        // throwaway module source and real CLI-generated browser decoders.
        const sourcePath = join(root, 'module/src/index.ts');
        const baselinePath = join(root, 'baseline.json');
        const describe = (database: string) => run('spacetime', ['--root-dir', env.STDB_TEST_ROOT, 'describe', '--json', '--server', `http://127.0.0.1:${dbPort}`, database]);
        await writeFile(baselinePath, await describe(env.STDB_TEST_DB));
        const source = await readFile(sourcePath, 'utf8');
        const edgeStart = source.indexOf('  edge: table(');
        const edgeEnd = source.indexOf('\n    }\n  ),', edgeStart);
        if (edgeStart < 0 || edgeEnd < 0 || source.includes('upgradeProbe')) throw new Error('Upgrade drill could not locate the edge schema');
        await writeFile(sourcePath, `${source.slice(0, edgeEnd)}\n      upgradeProbe: t.string().default('retained-edge'),${source.slice(edgeEnd)}`
          .replace(/ctx\.db\.edge\.insert\(\{(?!\s*\.\.\.)/g, "ctx.db.edge.insert({ upgradeProbe: 'retained-edge',"));
        const bindings = join(root, 'bindings');
        await symlink(join(repo, 'client/node_modules'), join(root, 'node_modules'), 'dir');
        const generate = async () => { await run('spacetime', ['generate', '--no-config', '--lang', 'typescript', '--module-path', join(root, 'module'), '--out-dir', bindings, '--yes']); };
        await generate();
        return {
          async publishModule() {
            // Describe the candidate on a different disposable database. A
            // rejection must leave the retained drawing's module untouched.
            const candidateDb = `${env.STDB_TEST_DB}-candidate`;
            await publish(candidateDb, '--yes', '--delete-data=always');
            const candidatePath = join(root, 'candidate.json');
            await writeFile(candidatePath, await describe(candidateDb));
            await run('node', [join(repo, 'scripts/check-wire-compat.mjs'), baselinePath, candidatePath]);
            await republish();
          },
          deployClient: () => buildClient(bindings),
          restorePreviousClient: () => buildClient(),
          async preservePublicEdge() {
            // Freeze the current public shape dynamically (including fields
            // already shipped), while the private storage gains a new field.
            // Expose the extended row under a new name for future clients.
            const source = await readFile(sourcePath, 'utf8');
            const marker = 'const spacetimedb = schema(tables);';
            const row = 't.array((tables as any)[key].rowType)';
            if (source.split(marker).length !== 2 || source.split(row).length !== 2) throw new Error('Upgrade drill could not preserve the public edge view');
            await writeFile(sourcePath, source
              .replace(marker, `${marker}\nconst upgradeLegacyEdge = t.row('UpgradeLegacyEdge', Object.fromEntries(Object.entries(tables.edge.rowType.row).filter(([column]) => column !== 'upgradeProbe')));`)
              .replace(row, "t.array(key === 'edge' ? upgradeLegacyEdge : (tables as any)[key].rowType)")
              + `\nexport const upgradeEdgeView = spacetimedb.view({ name: 'visible_edge_upgrade', public: true }, t.array(tables.edge.rowType), ctx => [...readableBoardIds(ctx)].flatMap(id => [...ctx.db.edge.boardId.filter(id)]));\n`);
            await generate();
          },
          readEdges: () => sql('SELECT * FROM edge'),
        };
      },
      async callReducer(token, reducer, args) {
        const response = await fetch(`http://127.0.0.1:${dbPort}/v1/database/${env.STDB_TEST_DB}/call/${reducer}`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
        });
        if (!response.ok) throw new Error(`${reducer} failed (${response.status}): ${await response.text()}`);
      },
      mintIdentity,
      async serviceIdentity(label) {
        const service = await mintIdentity();
        await sql(`INSERT INTO service_account (identity, label) VALUES (0x${service.identity}, '${label.replaceAll("'", "''")}')`);
        return service;
      },
      sql,
      republish,
      // JSON.stringify drops undefined claims, so { azp: undefined } removes azp.
      accountToken: (claims = {}) => issueToken(`user_${randomUUID()}`, claims),
    });
  } finally {
    try {
      for (const { child } of dashboards.values()) {
        if (child.exitCode !== null) continue;
        const stopped = once(child, 'exit');
        child.kill();
        await stopped;
      }
      if (preview && preview.exitCode === null) {
        const stopped = once(preview, 'exit');
        preview.kill();
        await stopped;
      }
      await run('bash', ['scripts/stdb-test.sh', 'stop']);
    } finally {
      await new Promise<void>(resolve => issuer.close(() => resolve()));
      await cp(join(root, 'database/server.log'), join(repo, `e2e/test-results/${logName}-database.log`)).catch(() => {});
      log.end();
      await rm(root, { recursive: true, force: true });
    }
  }
}
