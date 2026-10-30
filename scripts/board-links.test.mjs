// Every board link is <app>/#b=<slug> (shared/board-link.ts). Old ?boardId=<id>
// links still open (client/src/board-select.ts, mcp boardInLink, the module's
// slug-or-id lookup), but no code may build one again: this fails on any code
// that sets a boardId query parameter or writes `boardId=` before a value.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url);
const DIRS = ['module', 'client', 'mcp', 'agent', 'web', 'shared', 'scripts', 'importer', 'helper', 'e2e'];
// Only tests that prove old links still open may build one.
const ALLOWED = new Set([
  'client/src/board-select.test.ts',
  'e2e/tests/board-access.spec.ts', // an old numeric link still gives a stranger nothing
  'e2e/tests/sharing-live.spec.ts', // old links stay dead after a revoke, and canonicalize to #b=
  'scripts/board-links.test.mjs',
]);
const EMITTERS = [
  /\.(?:set|append)\(\s*['"`]boardId['"`]/, // url.searchParams.set('boardId', …)
  /[?&]boardId=(?:\$\{|\$\w|['"`]\s*\+)/, // `?boardId=${id}`, "?boardId=" + id, ?boardId=$id
];

export function emitters(files, read) {
  const found = [];
  for (const file of files) {
    if (ALLOWED.has(file)) continue;
    read(file).split('\n').forEach((line, i) => {
      if (EMITTERS.some(re => re.test(line))) found.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  return found;
}

test('no code builds a ?boardId= link', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...DIRS], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(f => /\.(?:[cm]?[jt]s|svelte|sh|ya?ml)$/.test(f) && !f.includes('/module_bindings/') && !f.includes('node_modules/'));
  assert.ok(files.length > 100, `scanned ${files.length} files`);
  const read = f => {
    try { return readFileSync(new URL(f, ROOT), 'utf8'); } catch { return ''; } // listed but deleted in the worktree
  };
  assert.deepEqual(emitters(files, read), [], 'build board links with boardHref (shared/board-link.ts): #b=<slug>, never ?boardId=');
});

test('the guard catches every way the old emitters built a link, and spares parsers', () => {
  const lines = {
    'a.ts': "url.searchParams.set('boardId', boardId.toString());",
    'b.ts': 'setDb(new URL(`${app}/?boardId=${id}`), db)',
    'c.svelte': "<a href={'?boardId=' + id}>",
    'd.sh': 'echo "open $canvas/?boardId=$id"',
    'e.ts': "u.searchParams.append(\"boardId\", '7');",
    'parse.ts': "const id = url.searchParams.get('boardId');",
    'strip.ts': "url.searchParams.delete('boardId');",
    'old-link.test.ts': "expect(selectBoard(boards, '?boardId=9')).toEqual(b);",
    'client/src/board-select.test.ts': 'selectBoard(boards, `?boardId=${bad}`)',
  };
  assert.deepEqual(emitters(Object.keys(lines), f => lines[f]).map(l => l.split(':')[0]), ['a.ts', 'b.ts', 'c.svelte', 'd.sh', 'e.ts']);
});
