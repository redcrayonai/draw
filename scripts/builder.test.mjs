import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchAll, fetchPlugin, gitEnv, parseArgs, resolveRef } from './builder.mjs';
import { writeLock } from './plugin-lock.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = (t, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const put = (base, files) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, file)), { recursive: true });
    writeFileSync(join(base, file), text);
  }
};
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
const PLUGIN = {
  'plugin.json': JSON.stringify({ id: 'pin', name: 'Pin', description: 'Pins.', draw: '^0.2.0' }),
  'module/index.ts': 'export const tables = {};\n',
  'module/index.test.ts': 'test\n',
  'web/index.ts': 'export {};\n',
  'README.md': 'not copied\n',
  'compose.yml': 'not copied\n',
  'package.json': '{"scripts":{"postinstall":"echo pwned"}}\n',
};
/** A plugin repository with tags; returns { url, commits }. */
function pluginRepo(t, files = PLUGIN) {
  const dir = temp(t, 'draw-plugin-repo-');
  git(dir, 'init', '-q');
  put(dir, files);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'v1');
  git(dir, 'tag', 'v1.0.0');
  git(dir, 'tag', '-a', 'v1.0.1', '-m', 'annotated');
  const first = git(dir, 'rev-parse', 'HEAD');
  put(dir, { 'server/index.ts': 'export const configured = () => true;\n' });
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'v2');
  git(dir, 'tag', 'v2.0.0');
  return { dir, url: `file://${dir}`, first, second: git(dir, 'rev-parse', 'HEAD') };
}
const env = gitEnv(process.env, { credentials: null });

test('refs resolve to commits: lightweight and annotated tags peel, commits pass through', t => {
  const repo = pluginRepo(t);
  assert.equal(resolveRef(repo.url, 'v1.0.0', env), repo.first);
  assert.equal(resolveRef(repo.url, 'v1.0.1', env), repo.first);
  assert.equal(resolveRef(repo.url, repo.second, env), repo.second);
  assert.throws(() => resolveRef(repo.url, 'v9', env), /ref must be a tag or a full commit; .* has no tag 'v9'/);
  assert.throws(() => resolveRef('file:///nonexistent/repo', 'v1', env), /plugin rule: cannot read/);
});

test('fetch writes only the plugin paths, drops tests, and keeps no git data', t => {
  const repo = pluginRepo(t), into = temp(t, 'draw-into-'), cache = temp(t, 'draw-cache-');
  assert.equal(fetchPlugin({ id: 'pin', repo: repo.url, ref: 'v1.0.0' }, { into, cache, env }), repo.first);
  assert.deepEqual(readdirSync(join(into, 'pin')).sort(), ['module', 'plugin.json', 'web']);
  assert.deepEqual(readdirSync(join(into, 'pin/module')), ['index.ts']);
  const files = readdirSync(into, { recursive: true }).map(file => join(into, file)).filter(file => !file.endsWith('module') && !file.endsWith('web') && !file.endsWith('pin'));
  for (const file of files) assert.ok(!readFileSync(file, 'utf8').includes(repo.dir), file);
  // a commit ref fetches by commit; refetching replaces the folder
  assert.equal(fetchPlugin({ id: 'pin', repo: repo.url, ref: repo.second }, { into, cache, env }), repo.second);
  assert.ok(existsSync(join(into, 'pin/server/index.ts')));
});

test('a moved tag is refused against the lock', t => {
  const repo = pluginRepo(t), into = temp(t, 'draw-into-'), cache = temp(t, 'draw-cache-');
  git(repo.dir, 'tag', '-f', 'v1.0.0', repo.second);
  assert.throws(() => fetchPlugin({ id: 'pin', repo: repo.url, ref: 'v1.0.0', commit: repo.first }, { into, cache, env }),
    /plugin rule: pin: tag v1\.0\.0 now points at [0-9a-f]{40}; the lock has [0-9a-f]{40}\. A moved tag is refused\./);
});

test('plugins without plugin.json or with node_modules are refused', t => {
  const into = temp(t, 'draw-into-'), cache = temp(t, 'draw-cache-');
  const bare = pluginRepo(t, { 'module/index.ts': 'x\n' });
  assert.throws(() => fetchPlugin({ id: 'pin', repo: bare.url, ref: 'v1.0.0' }, { into, cache, env }), /has no plugin\.json at the repository root/);
  const vendored = pluginRepo(t, { ...PLUGIN, 'web/node_modules/x/index.js': 'x\n' });
  assert.throws(() => fetchPlugin({ id: 'pin', repo: vendored.url, ref: 'v1.0.0' }, { into, cache, env }), /web\/node_modules is not allowed/);
});

test('git child processes get credentials from a secret file only, and never prompt', t => {
  const dir = temp(t, 'draw-secret-');
  writeFileSync(join(dir, 'creds'), 'https://u:canary-token@example.com\n');
  const out = gitEnv({ PATH: '/bin' }, { credentials: join(dir, 'creds') });
  assert.equal(out.GIT_TERMINAL_PROMPT, '0');
  assert.equal(out.GIT_CONFIG_VALUE_0, `store --file=${join(dir, 'creds')}`);
  assert.ok(!JSON.stringify(out).includes('canary-token'));
  assert.equal(gitEnv({}, { credentials: join(dir, 'missing') }).GIT_CONFIG_COUNT, undefined);
  writeFileSync(join(dir, 'known_hosts'), 'example.com ssh-ed25519 AAAA\n');
  assert.match(gitEnv({}, { knownHosts: join(dir, 'known_hosts') }).GIT_SSH_COMMAND, /StrictHostKeyChecking=yes/);
  assert.match(gitEnv({}, { knownHosts: join(dir, 'none') }).GIT_SSH_COMMAND, /StrictHostKeyChecking=accept-new/);
});

test('deploy fetch: lock rules first, then every included entry; skipped ones are not fetched', t => {
  const repo = pluginRepo(t), config = temp(t, 'draw-config-'), into = temp(t, 'draw-into-'), cache = temp(t, 'draw-cache-');
  const entry = { repo: repo.url, ref: 'v1.0.0', commit: repo.first, tables: {}, schema: null };
  writeFileSync(join(config, 'draw-plugins.json'), JSON.stringify({ plugins: { pin: { repo: repo.url, ref: 'v1.0.0' }, off: { repo: repo.url, ref: 'v2.0.0', skip: true } } }));
  writeLock(config, { lockVersion: 1, plugins: { pin: entry, off: { ...entry, ref: 'v2.0.0', commit: repo.second } } });
  assert.deepEqual(fetchAll({ config, into, cache, env: {} }), { pin: repo.first });
  assert.deepEqual(readdirSync(into), ['pin']);
  writeFileSync(join(config, 'draw-plugins.json'), JSON.stringify({ plugins: { pin: { path: '../pin' } } }));
  assert.throws(() => fetchAll({ config, into, cache, env: {} }), /is a local folder; deploy builds take only repo \+ ref/);
});

test('CLI: usage errors exit 2, refusals exit 1', t => {
  const cli = (...args) => spawnSync(process.execPath, [join(root, 'scripts/builder.mjs'), ...args], { encoding: 'utf8', cwd: temp(t, 'draw-cli-') });
  assert.equal(cli().status, 2);
  assert.equal(cli('fetch').status, 2);
  assert.equal(cli('fetch', '--into').status, 2);
  const refused = cli('fetch', '--into', 'out', '--config', '/nonexistent-config');
  assert.equal(refused.status, 0, refused.stderr); // no plugins file: nothing to fetch
  assert.deepEqual(parseArgs(['build', '--dev', '--out', 'x']), { command: 'build', flags: { dev: true, out: 'x' } });
});

test('check-lock: the lock must be a compatible upgrade of the base lock', async t => {
  const { lockProblems } = await import('./builder.mjs');
  const fixture = name => JSON.parse(readFileSync(join(root, 'scripts/fixtures/describe', name), 'utf8'));
  const { pluginSchema } = await import('./plugin-schema.mjs');
  const tables = { boardVersion: { why: 'x', board: 'outlives' }, boardVersionChunk: { why: 'x' }, versionCooldown: { why: 'x' } };
  const schema = pluginSchema(fixture('versions.json'), fixture('core.json'), tables).schema;
  const SHA = 'a'.repeat(40), SHA2 = 'b'.repeat(40);
  const entry = (more = {}) => ({ repo: 'https://example.com/v.git', ref: 'v1.0.0', commit: SHA, tables, schema, ...more });
  const lock = plugins => ({ lockVersion: 1, plugins });
  assert.deepEqual(lockProblems(lock({ v: entry() }), lock({ v: entry() })), []);
  assert.deepEqual(lockProblems(lock({ v: entry() }), lock({ v: entry({ ref: 'v1.1.0', commit: SHA2 }) })), []);
  assert.deepEqual(lockProblems(lock({ v: entry() }), lock({ v: entry({ retired: true }) })), []);
  assert.match(lockProblems(lock({ v: entry() }), lock({}))[0], /drops 'v', which has database tables/);
  assert.deepEqual(lockProblems(lock({ v: entry({ schema: null }) }), lock({})), []);
  assert.match(lockProblems(lock({ v: entry() }), lock({ v: entry({ commit: SHA2 }) }))[0], /tag v1\.0\.0 moved/);
  assert.match(lockProblems(lock({ v: entry() }), lock({ v: entry({ schema: null }) }))[0], /drops its database schema/);
  const edited = structuredClone(schema);
  edited.tables.boardVersionChunk.columns = edited.tables.boardVersionChunk.columns.map(([name, type]) => [name, name === 'data' ? 'U32' : type]);
  assert.match(lockProblems(lock({ v: entry() }), lock({ v: entry({ schema: edited }) })).join('\n'), /plugin rule: v: .*data/);
  assert.match(lockProblems({ lockVersion: 2, plugins: {} }, lock({}))[0], /lockVersion went back/);
});

test('check-lock CLI: missing base passes; an incompatible lock exits 1', t => {
  const config = temp(t, 'draw-config-');
  const cli = (...args) => spawnSync(process.execPath, [join(root, 'scripts/builder.mjs'), ...args], { encoding: 'utf8' });
  assert.equal(cli('check-lock', '--base', join(config, 'none.json'), '--config', config).status, 0);
  writeFileSync(join(config, 'base.json'), JSON.stringify({ lockVersion: 1, plugins: { ver: { repo: 'r', ref: 'v1', commit: 'a'.repeat(40), tables: {}, schema: { types: {}, tables: {}, wire: {} } } } }));
  const refused = cli('check-lock', '--base', join(config, 'base.json'), '--config', config);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /drops 'ver'/);
});
