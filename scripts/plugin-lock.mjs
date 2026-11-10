// Rules for outside plugins (PLUGINS.md, "Design: plugins outside this repo"): the draw
// versions a plugin supports, the plugins file and its lock. Pure functions; the builder
// (scripts/builder.mjs) does the I/O around them.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const rule = message => `plugin rule: ${message}`;
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const CARET = /^\^(\d+)\.(\d+)\.(\d+)$/;

/** `^1.4.0 || ^2.0.0` → [[1, 4, 0], [2, 0, 0]]. Only caret ranges: the interface follows semver. */
export function parseRange(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error(rule('draw must be a caret range such as "^0.3.0"'));
  return text.split('||').map(part => {
    const match = CARET.exec(part.trim());
    if (!match) throw new Error(rule(`draw must be a caret range such as "^0.3.0", not '${text}'`));
    return match.slice(1).map(Number);
  });
}

/** npm caret semantics: ^1.4.0 is >=1.4.0 <2.0.0, ^0.3.0 is >=0.3.0 <0.4.0, ^0.0.3 is 0.0.3 only. */
export function satisfies(version, range) {
  const match = VERSION.exec(version);
  if (!match) throw new Error(rule(`not a draw version: '${version}'`));
  const v = match.slice(1).map(Number);
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return parseRange(range).some(min => {
    const max = min[0] > 0 ? [min[0] + 1, 0, 0] : min[1] > 0 ? [0, min[1] + 1, 0] : [0, 0, min[2] + 1];
    return cmp(v, min) >= 0 && cmp(v, max) < 0;
  });
}

/** DRAW_VERSION, else /draw/VERSION in the builder image, else the newest v* tag; null when none. */
export function drawVersion(root, env = process.env, versionFile = '/draw/VERSION') {
  if (env.DRAW_VERSION) return env.DRAW_VERSION.replace(/^v/, '');
  if (existsSync(versionFile)) {
    const value = readFileSync(versionFile, 'utf8').trim().replace(/^v/, '');
    if (VERSION.test(value)) return value;
  }
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return tag.replace(/^v/, '');
  } catch {
    return null;
  }
}

/** Problems with a plugin's range against this draw; outside plugins must declare one. */
export function rangeProblems(plugin, version, { outside = false, label = plugin.id } = {}) {
  if (plugin.draw === undefined) return outside ? [rule(`${label} must declare the draw versions it supports ("draw": "^X.Y.Z" in plugin.json)`)] : [];
  if (!version) return [rule("cannot tell draw's version; fetch tags or set DRAW_VERSION")];
  return satisfies(version, plugin.draw) ? [] : [rule(`${label} supports draw ${plugin.draw}; this is draw ${version}. Upgrade the plugin, or mark it "skip": true.`)];
}

export { rule };

export const CONFIG_FILE = 'draw-plugins.json', LOCK_FILE = 'draw-plugins.lock.json';
const ID = /^[a-z][a-z0-9]{1,30}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const readText = (dir, file) => existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : undefined;

function repoProblem(repo) {
  if (typeof repo !== 'string') return 'repo must be a string';
  // scp-like ssh: user@host:path, never a URL with credentials
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s:]/.test(repo) && !repo.includes('://')) return /[?#]/.test(repo) ? 'repo must have no query or fragment' : null;
  let url;
  try { url = new URL(repo); } catch { return `repo must be an https://, ssh://, git@host:path or file:// URL, not '${repo}'`; }
  if (!['https:', 'ssh:', 'file:'].includes(url.protocol)) return `repo must be an https://, ssh://, git@host:path or file:// URL, not '${url.protocol}'`;
  if (url.password || (url.username && url.protocol !== 'ssh:')) return 'repo must not hold credentials; give them to the build as secrets';
  if (url.search || url.hash) return 'repo must have no query or fragment';
  return null;
}

// A tag name (git check-ref-format, simplified) or a full commit; short ids, HEAD and refs/ paths are refused.
const refOk = ref => typeof ref === 'string' && (/^[0-9a-f]{40}$/.test(ref)
  || (/^[A-Za-z0-9_][A-Za-z0-9._\/-]*$/.test(ref) && !/^[0-9a-f]{7,39}$/.test(ref) && ref !== 'HEAD' && !ref.startsWith('refs/')
    && !ref.includes('..') && !/(\.lock|\/|\.)$/.test(ref) && !ref.includes('//')));

/** draw-plugins.json → { plugins: { id: { kind: 'repo', repo, ref, skip } | { kind: 'path', path, skip } | { kind: 'retired' } } }. */
export function readConfig(dir) {
  const text = readText(dir, CONFIG_FILE);
  if (text === undefined) return { plugins: {} };
  const problems = [], plugins = {};
  const fail = (id, message) => problems.push(rule(`${CONFIG_FILE}: ${id ? `${id}: ` : ''}${message}`));
  let data;
  try { data = JSON.parse(text); } catch (error) { throw new Error(rule(`${CONFIG_FILE}: cannot read JSON: ${error.message}`)); }
  if (!object(data) || !object(data.plugins)) throw new Error(rule(`${CONFIG_FILE}: must be { "plugins": { … } }`));
  for (const key of Object.keys(data)) if (key !== 'plugins') fail('', `unknown field '${key}'`);
  for (const [id, value] of Object.entries(data.plugins)) {
    if (!ID.test(id)) { fail(id, 'id must match /^[a-z][a-z0-9]{1,30}$/'); continue; }
    if (!object(value)) { fail(id, 'must be an object'); continue; }
    if ('retired' in value) {
      if (value.retired !== true || Object.keys(value).length !== 1) fail(id, 'a retired entry is exactly { "retired": true }');
      else plugins[id] = { kind: 'retired' };
      continue;
    }
    const kind = 'path' in value && !('repo' in value) && !('ref' in value) ? 'path' : 'repo' in value && 'ref' in value && !('path' in value) ? 'repo' : null;
    if (!kind) { fail(id, 'use repo + ref, path, or { "retired": true }'); continue; }
    const before = problems.length;
    for (const key of Object.keys(value)) if (![...(kind === 'repo' ? ['repo', 'ref'] : ['path']), 'skip'].includes(key)) fail(id, `unknown field '${key}'`);
    if ('skip' in value && typeof value.skip !== 'boolean') fail(id, 'skip must be true or false');
    if (kind === 'path' && (typeof value.path !== 'string' || !value.path)) fail(id, 'path must be a non-empty string');
    if (kind === 'repo') {
      const problem = repoProblem(value.repo);
      if (problem) fail(id, problem);
      if (!refOk(value.ref)) fail(id, 'ref must be a tag or a full commit (branches and short ids move or collide)');
    }
    if (problems.length !== before) continue;
    plugins[id] = kind === 'repo' ? { kind, repo: value.repo, ref: value.ref, skip: value.skip === true } : { kind, path: value.path, skip: value.skip === true };
  }
  if (problems.length) throw new Error(problems.join('\n'));
  return { plugins };
}

/** draw-plugins.lock.json, or an empty lock. Written only by builder lock. */
export function readLock(dir, file = LOCK_FILE) {
  const text = readText(dir, file);
  if (text === undefined) return { lockVersion: 1, plugins: {} };
  const fail = message => { throw new Error(rule(`${file}: ${message}`)); };
  let data;
  try { data = JSON.parse(text); } catch (error) { fail(`cannot read JSON: ${error.message}`); }
  if (!object(data) || !Number.isInteger(data.lockVersion) || !object(data.plugins)) fail('must be { "lockVersion": 1, "plugins": { … } }');
  if (data.lockVersion > 1) fail(`lockVersion ${data.lockVersion} is newer than this builder reads (1); use a newer builder`);
  for (const key of Object.keys(data)) if (!['lockVersion', 'plugins'].includes(key)) fail(`unknown field '${key}'`);
  for (const [id, entry] of Object.entries(data.plugins)) {
    if (!ID.test(id) || !object(entry)) fail(`${id}: malformed entry`);
    for (const key of Object.keys(entry)) if (!['repo', 'ref', 'commit', 'draw', 'tables', 'schema', 'retired'].includes(key)) fail(`${id}: unknown field '${key}'`);
    if (typeof entry.repo !== 'string' || typeof entry.ref !== 'string' || !/^[0-9a-f]{40}$/.test(entry.commit ?? '')
      || !object(entry.tables) || !(entry.schema === null || object(entry.schema)) || ('retired' in entry && entry.retired !== true)) fail(`${id}: malformed entry; regenerate it with builder lock`);
  }
  return data;
}

const sorted = value => Array.isArray(value) ? value.map(sorted)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const writeLock = (dir, lock) => writeFileSync(join(dir, LOCK_FILE), `${JSON.stringify(sorted(lock), null, 2)}\n`);

const dropMessage = id => rule(`${CONFIG_FILE} drops '${id}', which has database tables. Mark it { "retired": true }: its tables and data stay. Deleting its data is a manual cleanup.`);
const inRepoMessage = id => rule(`${id}: is a plugin in this repository; it is always included and never goes in ${CONFIG_FILE}`);
const needsLock = (id, entry) => rule(entry.kind === 'retired'
  ? `${id}: { "retired": true } needs an entry in the lock; a plugin never locked has no tables to keep`
  : `${id}: "skip": true needs an entry in the lock; remove the entry instead, nothing would be kept`);
const movedPin = (entry, locked) => entry.repo !== locked.repo || entry.ref !== locked.ref;
const changed = (entry, locked) => movedPin(entry, locked) || locked.retired === true;
// A skipped plugin is not fetched, so its pin cannot move while skipped.
const skipMoved = (id, locked) => rule(`${id}: a skipped plugin keeps its locked pin (${locked.ref}); put that ref back, or drop "skip" to lock the new one`);

/** What builder lock does with each entry (spec §5.1). */
export function lockPlan(config, lock, inRepoIds) {
  const plan = { resolve: [], keep: [], skip: [], retire: [], drop: [], problems: [] };
  for (const [id, entry] of Object.entries(config.plugins)) {
    const locked = lock.plugins[id];
    if (inRepoIds.includes(id)) plan.problems.push(inRepoMessage(id));
    else if (entry.kind === 'path') continue;
    else if (entry.kind === 'retired' || entry.skip) {
      if (!locked) plan.problems.push(needsLock(id, entry));
      else if (entry.skip && movedPin(entry, locked)) plan.problems.push(skipMoved(id, locked));
      else plan[entry.kind === 'retired' ? 'retire' : 'skip'].push(id);
    } else plan[locked && !changed(entry, locked) ? 'keep' : 'resolve'].push(id);
  }
  for (const [id, locked] of Object.entries(lock.plugins)) {
    if (Object.hasOwn(config.plugins, id)) continue;
    if (locked.schema) plan.problems.push(dropMessage(id));
    else plan.drop.push(id);
  }
  return plan;
}

/** Why a deploy build refuses this plugins file and lock (spec §5.1). */
export function deployProblems(config, lock, inRepoIds, { dev = false } = {}) {
  const problems = [], stale = id => problems.push(rule(`${id}: lock is stale; run builder lock`));
  for (const [id, entry] of Object.entries(config.plugins)) {
    const locked = lock.plugins[id];
    if (inRepoIds.includes(id)) problems.push(inRepoMessage(id));
    else if (entry.kind === 'path') { if (!dev) problems.push(rule(`${CONFIG_FILE}: '${id}' is a local folder; deploy builds take only repo + ref. Use builder build --dev, or pin a tag.`)); }
    else if (!locked) problems.push(entry.kind === 'retired' || entry.skip ? needsLock(id, entry) : rule(`${id}: not in the lock; run builder lock`));
    else if (entry.kind === 'retired' ? locked.retired !== true : entry.skip ? movedPin(entry, locked) : changed(entry, locked)) stale(id);
  }
  for (const [id, locked] of Object.entries(lock.plugins)) {
    if (Object.hasOwn(config.plugins, id)) continue;
    if (locked.schema) problems.push(dropMessage(id));
    else stale(id);
  }
  return problems;
}
