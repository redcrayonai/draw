// The test plugin's later versions, as edits to v1 (scripts/fixtures/outside-plugin/v1).
// Each returns { file: text } overrides applied on top of the previous version.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERSIONS = {
  // v1.1.0: compatible. A private column appended with a default, a new table and index.
  'v1.1.0': files => ({
    'plugin.json': files['plugin.json'].replace('"pinboardNote": { "why": "pinboard notes", "board": "outlives" }',
      '"pinboardNote": { "why": "pinboard notes", "board": "outlives" },\n    "pinboardTag": { "why": "pinboard tags" }'),
    'module/index.ts': files['module/index.ts']
      .replace('    text: t.string(),\n  }),\n};', '    text: t.string(),\n    pinned: t.bool().default(false),\n  }),\n  pinboardTag: table({}, {\n    id: t.u64().primaryKey().autoInc(),\n    noteId: t.u64().index(\'btree\'),\n    tag: t.string(),\n  }),\n};'),
  }),
  // v2.0.0: incompatible. A column changes type.
  'v2.0.0': files => ({ 'module/index.ts': files['module/index.ts'].replace('    text: t.string(),\n    pinned', '    text: t.u32(),\n    pinned') }),
  // v2.1.0 (from v1.1.0): incompatible for older dashboards. The view's row gains a field.
  'v2.1.0': files => ({
    'module/index.ts': files['module/index.ts']
      .replace("text: t.string() });", "text: t.string(), pinned: t.bool() });")
      .replace('text: n.text })', 'text: n.text, pinned: n.pinned })'),
  }),
};
export const BASES = { 'v1.1.0': 'v1.0.0', 'v2.0.0': 'v1.1.0', 'v2.1.0': 'v1.1.0' };


const V1 = fileURLToPath(new URL('./v1/', import.meta.url));
const read = dir => Object.fromEntries(readdirSync(dir, { recursive: true }).map(String).filter(f => !f.endsWith('/') && !['module', 'server', 'web'].includes(f)).map(f => [f, readFileSync(join(dir, f), 'utf8')]));

/** Files of one tag; `range` replaces DRAW_RANGE. */
export function filesOf(tag, range) {
  const v1 = Object.fromEntries(Object.entries(read(V1)).map(([f, text]) => [f, text.replace('DRAW_RANGE', range)]));
  if (tag === 'v1.0.0') return v1;
  const base = filesOf(BASES[tag], range);
  return { ...base, ...VERSIONS[tag](base) };
}

/** A git repository at <dir> with every tag committed; returns { tag: commit }. */
export function makeRepo(dir, range, tags = ['v1.0.0', 'v1.1.0', 'v2.0.0', 'v2.1.0']) {
  const git = (...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  mkdirSync(dir, { recursive: true });
  git('init', '-q');
  const commits = {};
  for (const tag of tags) {
    git('rm', '-rq', '--ignore-unmatch', '.');
    for (const [file, text] of Object.entries(filesOf(tag, range))) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    git('add', '-A');
    git('commit', '-qm', tag, '--allow-empty');
    git('tag', tag);
    commits[tag] = git('rev-parse', 'HEAD');
  }
  return commits;
}
