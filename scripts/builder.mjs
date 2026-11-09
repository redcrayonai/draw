#!/usr/bin/env node
// The outside-plugin builder (PLUGINS.md, "Design: plugins outside this repo").
//
//   node scripts/builder.mjs fetch [--config dir] --into dir [--cache dir]
//   node scripts/builder.mjs check-lock --base <old lock file> [--config dir]
//
// The builder image runs this file as its entrypoint. Refusals start with
// `plugin rule:`; exit 1 for a refused input, 2 for usage.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readPlugins } from './plugin-build.mjs';
import { readConfig, readLock, deployProblems, rule } from './plugin-lock.mjs';
import { schemaProblems } from './plugin-schema.mjs';

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

const USAGE = 'usage: node scripts/builder.mjs fetch [--config dir] --into dir [--cache dir] | check-lock --base file [--config dir]';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { command, flags } = parseArgs(process.argv.slice(2));
    const config = resolve(flags.config ?? '.');
    const cache = resolve(flags.cache ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'draw-builder'));
    if (command === 'fetch') {
      if (!flags.into) throw Object.assign(new Error('fetch needs --into'), { usage: true });
      for (const [id, commit] of Object.entries(fetchAll({ config, into: resolve(flags.into), cache }))) console.log(`fetched ${id} ${commit}`);
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

