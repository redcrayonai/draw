#!/usr/bin/env node
// The outside-plugin builder (PLUGINS.md, "Design: plugins outside this repo").
//
//   node scripts/builder.mjs lock [--config dir]
//   node scripts/builder.mjs fetch [--config dir] --into dir [--cache dir]
//   node scripts/builder.mjs build [--config dir] [--sources dir] [--seams dir] --out dir [--dev]
//   node scripts/builder.mjs check-lock --base <old lock file> [--config dir]
//   node scripts/builder.mjs link [--config dir] | unlink
//
// The builder image runs this file as its entrypoint. Refusals start with
// `plugin rule:`; exit 1 for a refused input, 2 for usage.
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { generate, importProblems, readPlugins } from './plugin-build.mjs';
import { readConfig, readLock, writeLock, lockPlan, deployProblems, drawVersion, rangeProblems, rule } from './plugin-lock.mjs';
import { pluginSchema, renderRetained, same as sameJson, schemaProblems } from './plugin-schema.mjs';
import { publicWire } from './check-wire-compat.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMMIT = /^[0-9a-f]{40}$/;
const PATHS = ['plugin.json', 'module', 'server', 'web'];

/**
 * Environment for git child processes only: never prompt, credentials from a build
 * secret (a git credential-store file), ssh host keys from <config>/known_hosts.
 * Nothing is written to a git config file.
 */
export function gitEnv(env = process.env, { credentials = '/run/secrets/git_credentials', knownHosts } = {}) {
  const out = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' };
  if (credentials && existsSync(credentials)) {
    Object.assign(out, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: `store --file=${credentials}` });
  }
  const hostKeys = knownHosts && existsSync(knownHosts)
    ? `-o UserKnownHostsFile=${knownHosts} -o StrictHostKeyChecking=yes`
    // Safe for deploy builds: the fetched commit must equal the locked one.
    : '-o StrictHostKeyChecking=accept-new';
  out.GIT_SSH_COMMAND = `ssh -o BatchMode=yes ${hostKeys}`;
  return out;
}

const run = (args, options) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, ...options });

/** The commit a tag (peeled) or full commit names; refuses anything else. */
export function resolveRef(repo, ref, env) {
  if (COMMIT.test(ref)) return ref;
  let out;
  try { out = run(['ls-remote', repo, `refs/tags/${ref}`, `refs/tags/${ref}^{}`], { env }); }
  catch (error) { throw new Error(rule(`cannot read ${repo}: ${String(error.stderr || error.message).trim().split('\n').at(-1)}`)); }
  const lines = out.trim().split('\n').filter(Boolean).map(line => line.split('\t'));
  const peeled = lines.find(([, name]) => name.endsWith('^{}')) ?? lines[0];
  if (!peeled) throw new Error(rule(`ref must be a tag or a full commit; ${repo} has no tag '${ref}'`));
  return peeled[0];
}

/**
 * Fetches one plugin and writes only plugin.json, module/, server/ and web/ of its commit
 * to <into>/<id>/, without test files, .git or remote URLs. Returns the commit.
 */
export function fetchPlugin({ id, repo, ref, commit: locked }, { into, cache, env }) {
  const commit = resolveRef(repo, ref, env);
  if (locked && commit !== locked) {
    throw new Error(rule(`${id}: tag ${ref} now points at ${commit}; the lock has ${locked}. A moved tag is refused. Pin a new tag, or pin the commit you trust.`));
  }
  const store = join(cache, `${createHash('sha256').update(repo).digest('hex').slice(0, 16)}.git`);
  if (!existsSync(store)) run(['init', '--bare', '-q', store], { env });
  const git = (...args) => run(['-C', store, ...args], { env });
  try {
    git('cat-file', '-e', `${commit}^{commit}`);
  } catch {
    try { git('fetch', '-q', '--depth', '1', '--no-tags', repo, COMMIT.test(ref) ? commit : `refs/tags/${ref}`); }
    catch (error) { throw new Error(rule(`${id}: cannot fetch ${ref} from ${repo}: ${String(error.stderr || error.message).trim().split('\n').at(-1)}`)); }
    if (git('rev-parse', 'FETCH_HEAD^{commit}').trim() !== commit) throw new Error(rule(`${id}: ${repo} served a different commit for ${ref} than it advertised`));
  }
  const present = git('ls-tree', '--name-only', commit).split('\n').filter(name => PATHS.includes(name));
  if (!present.includes('plugin.json')) throw new Error(rule(`${id}: ${ref} has no plugin.json at the repository root`));
  const target = join(into, id);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const archive = execFileSync('git', ['-C', store, 'archive', '--format=tar', commit, ...present], { env, maxBuffer: 1 << 28 });
  execFileSync('tar', ['-x', '-C', target], { input: archive });
  const problems = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name === 'node_modules') problems.push(rule(`${id}: ${path.slice(target.length + 1)} is not allowed; plugins use only what draw installs`));
      else if (entry.isDirectory()) walk(path);
      else if (/\.test\./.test(entry.name)) rmSync(path);
    }
  };
  walk(target);
  if (problems.length) throw new Error(problems.join('\n'));
  return commit;
}

const inRepoIds = root => readPlugins(root).map(plugin => plugin.id);

/** Deploy-mode fetch: every included repo entry, verified against the lock. */
export function fetchAll({ config: dir, into, cache, root = ROOT, env = process.env }) {
  const config = readConfig(dir), lock = readLock(dir);
  const problems = deployProblems(config, lock, inRepoIds(root));
  if (problems.length) throw new Error(problems.join('\n'));
  return fetchIncluded(config, lock, { dir, into, cache, env });
}

function fetchIncluded(config, lock, { dir, into, cache, env }) {
  const git = gitEnv(env, { knownHosts: join(dir, 'known_hosts') });
  mkdirSync(into, { recursive: true });
  mkdirSync(cache, { recursive: true });
  const fetched = {};
  for (const [id, entry] of Object.entries(config.plugins).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (entry.kind !== 'repo' || entry.skip) continue;
    fetched[id] = fetchPlugin({ id, repo: entry.repo, ref: entry.ref, commit: lock.plugins[id].commit }, { into, cache, env: git });
  }
  return fetched;
}

// ---- scratch workspace ----

const PACKAGES = ['module', 'shared', 'agent', 'mcp', 'client', 'web'];
const SKIP = new Set(['node_modules', '.svelte-kit', 'dist', '.wrangler', '.api-base', '.seams']);

/** Copies a package without build output, linking its installed node_modules. */
function copyPackage(from, to) {
  cpSync(from, to, { recursive: true, filter: source => !SKIP.has(source.slice(from.length).split('/')[1] ?? '') || source === from });
  if (existsSync(join(from, 'node_modules'))) symlinkSync(realpathSync(join(from, 'node_modules')), join(to, 'node_modules'));
}

/**
 * A scratch copy of draw at <work> with outside plugins placed in plugins/<id> and
 * retained tables rendered, generated files written. The source tree is never modified.
 */
export function prepare(root, work, { sources = {}, retained = [], modulesOnly = false } = {}) {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  for (const dir of modulesOnly ? ['module', 'shared'] : PACKAGES) if (existsSync(join(root, dir))) copyPackage(join(root, dir), join(work, dir));
  cpSync(join(root, 'plugins'), join(work, 'plugins'), { recursive: true, dereference: true, filter: source => !source.includes('/node_modules') });
  cpSync(join(root, 'scripts'), join(work, 'scripts'), { recursive: true, filter: source => !source.includes('/fixtures') });
  cpSync(join(root, 'docker/prod'), join(work, 'docker/prod'), { recursive: true });
  if (modulesOnly) mkdirSync(join(work, 'web/src/lib/server'), { recursive: true });
  for (const [id, dir] of Object.entries(sources)) {
    if (existsSync(join(work, 'plugins', id))) throw new Error(rule(`${id}: a plugin in this repo already has that id`));
    cpSync(dir, join(work, 'plugins', id), { recursive: true });
  }
  const plugins = readPlugins(work);
  const problems = importProblems(work, plugins);
  if (problems.length) throw new Error(problems.join('\n'));
  for (const [file, content] of generate(work, plugins, retained.map(({ id, tables, schema }) => ({ id, tables, source: renderRetained(id, schema) })))) {
    mkdirSync(dirname(join(work, file)), { recursive: true });
    writeFileSync(join(work, file), content);
  }
  return plugins;
}

// ---- disposable database ----

const freePort = () => Number(execFileSync(process.execPath, ['-e', "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: 'utf8' }).trim());
const plain = text => text.replace(/\x1b\[[0-9;]*m/g, '');

/** A local database for schema capture and checks, started with scripts/stdb-test.sh. */
export function database(work) {
  const dir = mkdtempSync(join(tmpdir(), 'draw-builder-db-')), port = freePort(), url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, STDB_TEST_ROOT: dir, STDB_TEST_PORT: String(port) };
  const script = join(work, 'scripts/stdb-test.sh');
  const started = spawnSync('bash', [script, 'start'], { env, encoding: 'utf8' });
  if (started.status !== 0) throw new Error(rule(`the local database did not start: ${started.stderr.trim()}`));
  const cli = (args, cwd) => spawnSync('spacetime', ['--root-dir', dir, ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  return {
    /** Publishes <moduleDir>; fresh replaces the database, otherwise an update that never deletes data. */
    publish(moduleDir, name, { fresh = false } = {}) {
      // One stream in order, as module-setup logs it (docker/prod/rollback.sh reads that log).
      const result = spawnSync('sh', ['-c', 'exec "$@" 2>&1', 'sh', 'spacetime', '--root-dir', dir, 'publish', '--no-config', '--server', url,
        ...(fresh ? ['--yes', '--delete-data=always'] : ['--yes=break-clients,migrate']), name], { cwd: moduleDir, encoding: 'utf8', maxBuffer: 1 << 28 });
      return { ok: result.status === 0, log: plain(result.stdout) };
    },
    /** SQL as the database owner; the module must carry the local issuers (scripts/module-env.mjs). */
    sql(name, query) {
      const result = cli(['sql', '--server', url, name, query]);
      if (result.status !== 0) throw new Error(rule(`sql failed: ${query}: ${result.stderr.trim()}`));
      return plain(result.stdout);
    },
    describe(name) {
      const result = cli(['describe', '--json', '--server', url, name]);
      if (result.status !== 0) throw new Error(rule(`cannot describe the local database: ${result.stderr.trim()}`));
      return JSON.parse(result.stdout);
    },
    stop() {
      spawnSync('bash', [script, 'stop'], { env });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const logTail = log => log.split('\n').filter(line => line.trim() && !/^\s*•|CIRCULAR_DEPENDENCY|^WARNING/.test(line)).slice(-6).join('\n');

/** The database description of draw with only its in-repo plugins, cached per source content. */
function coreDescribe(root, db) {
  const baked = join(root, '.builder/core.describe.json');
  if (existsSync(baked)) return JSON.parse(readFileSync(baked, 'utf8'));
  const hash = createHash('sha256');
  for (const dir of ['module/src', 'plugins']) {
    for (const file of readdirSync(join(root, dir), { recursive: true }).map(String).sort()) {
      const path = join(root, dir, file);
      if (!file.includes('node_modules') && lstatSync(path).isFile()) hash.update(file).update(readFileSync(path));
    }
  }
  const cached = join(root, 'module/node_modules/.cache/draw-builder', `core-${hash.digest('hex').slice(0, 16)}.json`);
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
  const work = mkdtempSync(join(tmpdir(), 'draw-builder-core-'));
  try {
    prepare(root, work, { modulesOnly: true });
    const published = db.publish(join(work, 'module'), 'core', { fresh: true });
    if (!published.ok) throw new Error(rule(`draw's own module did not publish:\n${logTail(published.log)}`));
    const describe = db.describe('core');
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, JSON.stringify(describe));
    return describe;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

const CHANGED = /\b(Removed|Created|Changed)\b.*\b(index|constraint|column|sequence|table)\b/i;

// ---- lock ----

/** builder lock: resolve new and changed entries, capture schemas, apply the upgrade rules. */
export function lock({ config: dir, root = ROOT, cache, env = process.env }) {
  const config = readConfig(dir), current = readLock(dir), next = structuredClone(current);
  const plan = lockPlan(config, current, inRepoIds(root));
  if (plan.problems.length) throw new Error(plan.problems.join('\n'));
  const git = gitEnv(env, { knownHosts: join(dir, 'known_hosts') });
  const scratch = mkdtempSync(join(tmpdir(), 'draw-builder-lock-'));
  let db;
  try {
    for (const id of plan.keep) {
      const { repo, ref } = config.plugins[id];
      fetchPlugin({ id, repo, ref, commit: current.plugins[id].commit }, { into: join(scratch, 'kept'), cache, env: git });
    }
    const version = drawVersion(root, env);
    for (const id of plan.resolve) {
      const { repo, ref } = config.plugins[id], into = join(scratch, 'sources');
      const commit = fetchPlugin({ id, repo, ref }, { into, cache, env: git });
      const manifest = JSON.parse(readFileSync(join(into, id, 'plugin.json'), 'utf8'));
      const tables = manifest.tables ?? {};
      const problems = [
        ...(manifest.id !== id ? [rule(`${id}: ${ref} has plugin id '${manifest.id}'; the plugins file names it '${id}'`)] : []),
        ...rangeProblems(manifest, version, { outside: true, label: `${id}@${ref}` }),
      ];
      if (problems.length) throw new Error(problems.join('\n'));
      const work = join(scratch, `work-${id}`);
      const plugin = prepare(root, work, { sources: { [id]: join(into, id) }, modulesOnly: true }).find(p => p.id === id);
      let schema = null;
      if (plugin.parts.module) {
        db ??= database(work);
        const core = coreDescribe(root, db);
        const published = db.publish(join(work, 'module'), `lock-${id}`, { fresh: true });
        if (!published.ok) throw new Error(rule(`${id}@${ref}: the module did not publish with this plugin:\n${logTail(published.log)}`));
        const captured = pluginSchema(db.describe(`lock-${id}`), core, tables);
        if (captured.problems.length) throw new Error(captured.problems.map(p => rule(`${id}@${ref}: ${p}`)).join('\n'));
        schema = captured.schema;
        const old = current.plugins[id];
        if (old?.schema) {
          const upgrade = schemaProblems(old.schema, schema, id);
          if (upgrade.length) throw new Error(upgrade.join('\n'));
          // The database decides too: the old locked tables, then the new plugin as an update.
          const before = join(scratch, `before-${id}`);
          prepare(root, before, { retained: [{ id, tables: old.tables, schema: old.schema }], modulesOnly: true });
          const base = db.publish(join(before, 'module'), `upgrade-${id}`, { fresh: true });
          if (!base.ok) throw new Error(rule(`${id}: the locked tables did not publish:\n${logTail(base.log)}`));
          const upgraded = db.publish(join(work, 'module'), `upgrade-${id}`);
          if (!upgraded.ok) throw new Error(rule(`${id}: ${old.ref} → ${ref}: the database refuses this upgrade:\n${logTail(upgraded.log)}`));
        }
        // Round trip: the rendered tables must replace the plugin without any table change.
        const retained = join(scratch, `retained-${id}`);
        prepare(root, retained, { retained: [{ id, tables, schema }], modulesOnly: true, sources: {} });
        rmSync(join(retained, 'plugins', id), { recursive: true, force: true });
        const back = db.publish(join(retained, 'module'), `lock-${id}`);
        const changed = back.log.split('\n').filter(line => CHANGED.test(line));
        const again = back.ok && pluginSchema(db.describe(`lock-${id}`), core, tables);
        if (!back.ok || changed.length || !sameJson(again.schema.tables, schema.tables) || !sameJson(again.schema.types, schema.types)) {
          throw new Error(rule(`${id}@${ref}: its tables could not be rebuilt for a later skip or retirement:\n${back.ok ? changed.join('\n') || 'the tables differ' : logTail(back.log)}`));
        }
      }
      next.plugins[id] = { repo, ref, commit, ...(manifest.draw ? { draw: manifest.draw } : {}), tables, schema };
    }
  } finally {
    db?.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const id of plan.retire) next.plugins[id] = { ...next.plugins[id], retired: true };
  for (const id of plan.drop) delete next.plugins[id];
  writeLock(dir, next);
  return { plan, lock: next };
}

/**
 * Every locked plugin's tables in the compiled module equal the lock exactly, and an
 * included plugin's locked public contracts are unchanged. `states`: id → included |
 * skipped | retired | local; `pluginKeys`: every plugin table key in the module.
 */
export function verifyLocked(candidate, locked, states, pluginKeys) {
  const keys = new Set(pluginKeys);
  const core = { sections: candidate.sections.map(section => section.Tables ? { Tables: section.Tables.filter(t => !keys.has(t.source_name)) } : section) };
  const wire = publicWire(candidate), drift = [];
  for (const [id, entry] of Object.entries(locked.plugins)) {
    if (!entry.schema || !['included', 'skipped', 'retired'].includes(states[id])) continue;
    const found = pluginSchema(candidate, core, entry.tables).schema;
    for (const [key, table] of Object.entries(entry.schema.tables)) {
      if (!sameJson(found.tables[key], table)) drift.push(rule(`${id}: table ${table.name} differs from the lock; the lock is not what ${entry.ref} compiles to. Run builder lock.`));
    }
    if (states[id] === 'included') for (const [name, contract] of Object.entries(entry.schema.wire)) {
      if (!sameJson(wire[name], contract)) drift.push(rule(`${id}: public ${contract.kind} ${name} differs from the lock. Run builder lock.`));
    }
  }
  return drift;
}

// ---- build ----

const PROVIDERS = { anonymous: {}, oidc: { VITE_OIDC_ISSUER: '__rc_oidc_issuer__', VITE_OIDC_CLIENT_ID: '__rc_oidc_client_id__' } };
const sh = (command, args, options) => {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...options, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', ...options.env } });
  if (result.status !== 0) throw new Error(rule(`${[command, ...args].join(' ')} failed:\n${logTail(`${result.stdout}\n${result.stderr}`)}`));
  return result.stdout;
};

/** builder build: §7.1 of the builder spec. Returns build.json's content. */
export function build({ config: dir, root = ROOT, out, sources, seams, dev = false, cache, env = process.env }) {
  const config = readConfig(dir), locked = readLock(dir);
  const paths = Object.fromEntries(Object.entries(config.plugins).filter(([, entry]) => entry.kind === 'path'));
  const problems = deployProblems(dev ? { plugins: Object.fromEntries(Object.entries(config.plugins).filter(([id]) => !paths[id])) } : config, locked, inRepoIds(root));
  if (problems.length) throw new Error(problems.join('\n'));
  const scratch = mkdtempSync(join(tmpdir(), 'draw-builder-'));
  let db;
  try {
    const fetchedDir = sources ?? join(scratch, 'sources');
    if (!sources) fetchIncluded(config, locked, { dir, into: fetchedDir, cache, env });
    const placed = {}, retained = [], states = {};
    for (const [id, entry] of Object.entries(config.plugins)) {
      const lockEntry = locked.plugins[id];
      if (entry.kind === 'path' && !entry.skip) { placed[id] = resolve(dir, entry.path); states[id] = 'local'; }
      else if (entry.kind === 'repo' && !entry.skip) { placed[id] = join(fetchedDir, id); states[id] = 'included'; }
      else {
        states[id] = entry.kind === 'retired' ? 'retired' : 'skipped';
        if (lockEntry?.schema) retained.push({ id, tables: lockEntry.tables, schema: lockEntry.schema });
      }
    }
    const version = drawVersion(root, env);
    const rangeIssues = Object.keys(placed).flatMap(id => rangeProblems(JSON.parse(readFileSync(join(placed[id], 'plugin.json'), 'utf8')), version, { outside: true, label: id }));
    if (rangeIssues.length) throw new Error(rangeIssues.join('\n'));
    const work = join(scratch, 'work');
    const plugins = prepare(root, work, { sources: placed, retained });
    if (seams) for (const pkg of ['web', 'client', 'mcp']) cpSync(seams, join(work, pkg, '.seams'), { recursive: true });
    const has = file => seams && existsSync(join(seams, file));

    // The module: compile, type-check plugin parts, and compare plugin tables with the lock.
    sh('spacetime', ['build'], { cwd: join(work, 'module') });
    sh(join(work, 'module/node_modules/.bin/tsc'), ['--noEmit', '-p', 'tsconfig.json'], { cwd: join(work, 'module') });
    db = database(work);
    const published = db.publish(join(work, 'module'), 'build', { fresh: true });
    if (!published.ok) throw new Error(rule(`the module did not publish:\n${logTail(published.log)}`));
    const candidate = db.describe('build');
    db.stop();
    db = undefined;
    const pluginKeys = [...plugins.flatMap(p => Object.keys(p.tables)), ...retained.flatMap(r => Object.keys(r.tables))];
    const drift = verifyLocked(candidate, locked, states, pluginKeys);
    if (drift.length) throw new Error(drift.join('\n'));

    // The dashboard reads plugin tables through regenerated bindings.
    sh('spacetime', ['generate', '--no-config', '--lang', 'typescript', '--module-path', join(work, 'module'), '--out-dir', join(work, 'web/src/module_bindings')], { cwd: work });
    const web = join(work, 'web'), bin = pkg => name => join(work, pkg, 'node_modules/.bin', name);
    sh(bin('web')('svelte-kit'), ['sync'], { cwd: web });
    sh(bin('web')('svelte-check'), ['--tsconfig', './tsconfig.json', '--threshold', 'error'], { cwd: web });
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const variants = { ...PROVIDERS, ...(has('auth.ts') ? { custom: {} } : {}) };
    const provider = name => name === 'custom' ? './.seams/auth.ts' : name;
    const check = (dirOut, ...names) => sh('sh', [join(work, 'docker/prod/check-placeholders.sh'), dirOut, ...names], { cwd: work });
    const dashboardEnv = { VITE_SPACETIME_URI: '__rc_spacetime_uri__', VITE_SPACETIME_DB: '__rc_spacetime_db__', VITE_CANVAS_URL: '__rc_canvas_url__', VITE_MCP_URL: '__rc_mcp_url__' };
    for (const [name, extra] of Object.entries(variants)) {
      const target = join(out, 'dashboard', name);
      sh(bin('web')('vite'), ['build'], { cwd: web, env: { ...dashboardEnv, ...extra, VITE_AUTH_PROVIDER: provider(name) } });
      sh(bin('web')('wrangler'), ['deploy', '--dry-run', '--env', '', '--outdir', target, ...(has('worker-extra.js') ? ['--alias', 'redcrayon-worker-extra:./.seams/worker-extra.js'] : [])], { cwd: web, env: { ...dashboardEnv, ...extra } });
      cpSync(join(web, '.svelte-kit/cloudflare'), join(target, 'assets'), { recursive: true });
      for (const file of ['assets/_worker.js', 'assets/_headers', 'README.md']) rmSync(join(target, file), { force: true });
      for (const file of readdirSync(target)) if (file.endsWith('.map')) rmSync(join(target, file));
      writeFileSync(join(target, 'worker.js'), readFileSync(join(target, 'worker.js'), 'utf8').replace(/^\/\/# sourceMappingURL=.*\n?/gm, ''));
      check(target, 'spacetime_uri', 'spacetime_db', 'canvas_url', 'mcp_url', ...(name === 'oidc' ? ['oidc_issuer', 'oidc_client_id'] : []));
    }
    const client = join(work, 'client');
    const canvasEnv = { VITE_SPACETIME_URI: '__rc_spacetime_uri__', VITE_SPACETIME_DB: '__rc_spacetime_db__', VITE_DASHBOARD_URL: '__rc_dashboard_url__', VITE_MCP_URL: '__rc_mcp_url__' };
    for (const [name, extra] of Object.entries(variants)) {
      const target = join(out, 'canvas', name);
      const oidc = name === 'oidc' ? { ...extra, VITE_REQUIRE_AUTH: '__rc_require_auth__' } : extra;
      sh(bin('client')('vite'), ['build', '--outDir', target], { cwd: client, env: { ...canvasEnv, ...oidc, VITE_AUTH_PROVIDER: provider(name) } });
      check(target, 'spacetime_uri', 'spacetime_db', 'dashboard_url', 'mcp_url', ...(name === 'oidc' ? ['oidc_issuer', 'oidc_client_id', 'require_auth'] : []));
    }
    const mcp = join(work, 'mcp'), mcpOut = join(scratch, 'mcp-out');
    sh(bin('mcp')('wrangler'), ['deploy', ...(has('mcp-worker.ts') ? ['./.seams/mcp-worker.ts'] : []), '--dry-run', '--env', '', '--outdir', mcpOut], { cwd: mcp });
    mkdirSync(join(out, 'mcp'), { recursive: true });
    cpSync(join(mcpOut, 'worker.js'), join(out, 'mcp/worker.js'));

    // What module-setup publishes: the module with its dependencies, included plugin module parts, shared.
    const program = join(out, 'module-program');
    const noTests = source => !/\.test\./.test(source);
    cpSync(join(work, 'module'), join(program, 'module'), { recursive: true, filter: source => noTests(source) && !source.endsWith('/node_modules') });
    cpSync(realpathSync(join(root, 'module/node_modules')), join(program, 'module/node_modules'), { recursive: true, verbatimSymlinks: true });
    for (const plugin of plugins) if (plugin.parts.module) cpSync(join(work, 'plugins', plugin.id, 'module'), join(program, 'plugins', plugin.id, 'module'), { recursive: true, filter: noTests });
    cpSync(join(work, 'shared'), join(program, 'shared'), { recursive: true, filter: source => noTests(source) && !source.endsWith('/node_modules') });
    if (existsSync(join(root, 'shared/node_modules'))) cpSync(realpathSync(join(root, 'shared/node_modules')), join(program, 'shared/node_modules'), { recursive: true, verbatimSymlinks: true });
    cpSync(join(work, 'docker/prod/dashboard.capnp'), join(out, 'dashboard.capnp'));
    writeFileSync(join(out, 'plugin-settings.env.example'), plugins.filter(p => p.settings.length)
      .map(p => `# ${p.name} (${p.id})\n${p.settings.map(name => `${name}=`).join('\n')}\n`).join('\n'));
    const lockText = existsSync(join(dir, 'draw-plugins.lock.json')) ? readFileSync(join(dir, 'draw-plugins.lock.json')) : '';
    const summary = {
      draw: version,
      plugins: Object.fromEntries(Object.entries(states).sort().map(([id, state]) => [id, { state, ...(locked.plugins[id] ? { ref: locked.plugins[id].ref, commit: locked.plugins[id].commit } : {}) }])),
      inRepo: plugins.filter(p => !placed[p.id]).map(p => p.id),
      lockSha256: createHash('sha256').update(lockText).digest('hex'),
      seams: ['auth.ts', 'worker-extra.js', 'mcp-worker.ts'].filter(has),
    };
    writeFileSync(join(out, 'build.json'), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  } finally {
    db?.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- link (clone-only development) ----

export function link({ config: dir, root = ROOT }) {
  const config = readConfig(dir), linked = [];
  for (const [id, entry] of Object.entries(config.plugins)) {
    if (entry.kind !== 'path') continue;
    const target = join(root, 'plugins', id);
    if (existsSync(target) && !lstatSync(target).isSymbolicLink()) throw new Error(rule(`${id}: plugins/${id} exists in this repo`));
    rmSync(target, { force: true });
    symlinkSync(resolve(dir, entry.path), target);
    const exclude = join(root, '.git/info/exclude');
    if (existsSync(dirname(exclude)) && !readFileSync(exclude, 'utf8').split('\n').includes(`/plugins/${id}`)) appendFileSync(exclude, `/plugins/${id}\n`);
    linked.push(id);
  }
  regenerate(root);
  return linked;
}

export function unlink({ root = ROOT }) {
  const removed = [];
  for (const id of readdirSync(join(root, 'plugins'))) {
    if (lstatSync(join(root, 'plugins', id)).isSymbolicLink()) { rmSync(join(root, 'plugins', id)); removed.push(id); }
  }
  regenerate(root);
  return removed;
}

function regenerate(root) {
  const plugins = readPlugins(root);
  const problems = importProblems(root, plugins);
  if (problems.length) throw new Error(problems.join('\n'));
  for (const [file, content] of generate(root, plugins)) writeFileSync(join(root, file), content);
}

/**
 * check-lock: the current lock must be a compatible upgrade of a base lock. Deploy builds
 * prove the lock matches the locked commits; this proves the lock history is safe.
 */
export function lockProblems(base, current) {
  const problems = [];
  if (current.lockVersion < base.lockVersion) problems.push(rule(`lockVersion went back from ${base.lockVersion} to ${current.lockVersion}`));
  for (const [id, old] of Object.entries(base.plugins)) {
    const now = current.plugins[id];
    if (!now) {
      if (old.schema) problems.push(rule(`the lock drops '${id}', which has database tables. Mark it { "retired": true }: its tables and data stay.`));
      continue;
    }
    if (now.repo === old.repo && now.ref === old.ref && now.commit !== old.commit && !COMMIT.test(old.ref)) {
      problems.push(rule(`${id}: tag ${old.ref} moved from ${old.commit} to ${now.commit}; a moved tag is refused`));
    }
    if (old.schema && !now.schema) problems.push(rule(`${id}: the lock drops its database schema; its tables would go`));
    else if (old.schema) problems.push(...schemaProblems(old.schema, now.schema, id));
  }
  return problems;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv, flags = {};
  for (let i = 0; i < rest.length; i++) {
    const match = /^--([a-z-]+)$/.exec(rest[i]);
    if (!match) throw Object.assign(new Error(`unexpected argument '${rest[i]}'`), { usage: true });
    flags[match[1]] = ['dev'].includes(match[1]) ? true : rest[++i];
    if (flags[match[1]] === undefined) throw Object.assign(new Error(`--${match[1]} needs a value`), { usage: true });
  }
  return { command, flags };
}

const USAGE = `usage: node scripts/builder.mjs <command>
  lock       [--config dir] [--cache dir]
  fetch      [--config dir] --into dir [--cache dir]
  build      [--config dir] [--sources dir] [--seams dir] --out dir [--dev] [--cache dir]
  check-lock --base file [--config dir]
  link       [--config dir]
  unlink`;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { command, flags } = parseArgs(process.argv.slice(2));
    const config = resolve(flags.config ?? '.');
    const cache = resolve(flags.cache ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'draw-builder'));
    if (command === 'fetch') {
      if (!flags.into) throw Object.assign(new Error('fetch needs --into'), { usage: true });
      for (const [id, commit] of Object.entries(fetchAll({ config, into: resolve(flags.into), cache }))) console.log(`fetched ${id} ${commit}`);
    } else if (command === 'lock') {
      const { plan } = lock({ config, cache });
      console.log(`lock: resolved ${plan.resolve.join(', ') || 'nothing'}; kept ${plan.keep.length}; retired ${plan.retire.join(', ') || 'none'}; dropped ${plan.drop.join(', ') || 'none'}`);
    } else if (command === 'build') {
      if (!flags.out) throw Object.assign(new Error('build needs --out'), { usage: true });
      const summary = build({ config, cache, out: resolve(flags.out), dev: Boolean(flags.dev), sources: flags.sources && resolve(flags.sources), seams: flags.seams && resolve(flags.seams) });
      console.log(`build: draw ${summary.draw}; ${Object.entries(summary.plugins).map(([id, p]) => `${id} ${p.state}`).join(', ') || 'no outside plugins'} → ${flags.out}`);
    } else if (command === 'link') {
      console.log(`linked ${link({ config }).join(', ') || 'nothing'}; run unlink before committing`);
    } else if (command === 'unlink') {
      console.log(`unlinked ${unlink({}).join(', ') || 'nothing'}`);
    } else if (command === 'check-lock') {
      if (!flags.base) throw Object.assign(new Error('check-lock needs --base'), { usage: true });
      const base = existsSync(flags.base) ? readLock(dirname(resolve(flags.base)), basename(flags.base)) : null;
      const problems = base ? lockProblems(base, readLock(config)) : [];
      if (problems.length) throw new Error(problems.join('\n'));
      console.log(base ? 'check-lock: the lock is a compatible upgrade of the base' : 'check-lock: no base lock; nothing to compare');
    } else {
      throw Object.assign(new Error(`unknown command '${command ?? ''}'`), { usage: true });
    }
  } catch (error) {
    if (error.usage) { console.error(`${error.message}\n${USAGE}`); process.exitCode = 2; }
    else { console.error(error.message.startsWith('plugin rule:') ? error.message : rule(error.message)); process.exitCode = 1; }
  }
}

