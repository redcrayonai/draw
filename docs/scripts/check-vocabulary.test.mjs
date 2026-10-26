import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

// Exercise the actual CI command so the exception cannot expand unnoticed.
const workflow = readFileSync(new URL('../../.github/workflows/docs.yml', import.meta.url), 'utf8');
const scan = workflow.split('run: |').at(-1).replace(/^ {10}/gm, '');
const cases = [
  ['self-host/quickstart.md', 'SpacetimeDB and VITE_SPACETIME_URI', true],
  ['self-host/quickstart.md', 'SPACETIME_DB SPACETIMEDB_SERVICE_TOKEN', true],
  ['self-host/quickstart.md', 'SpacetimeDB clerk', false],
  ['self-host/quickstart.md', 'SPACETIMEDB_UNKNOWN', false],
  ['self-host/quickstart.md', 'SPACETIMEDB_URL_DEBUG', false],
  ['connect.md', 'SpacetimeDB', false],
  ['connect.md', 'VITE_SPACETIME_URI', false],
  ['connect.md', 'clockwork', false],
];

for (const [page, content, allowed] of cases) {
  test(`${page}: ${content} is ${allowed ? 'allowed' : 'rejected'}`, t => {
    const root = mkdtempSync(join(tmpdir(), 'draw-docs-scan-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'docs/src/content/docs', page);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content + '\n');
    writeFileSync(join(root, 'docs/astro.config.mjs'), '// config\n');
    const result = spawnSync('bash', ['-o', 'pipefail', '-c', scan], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, allowed ? 0 : 1, `${result.stdout}\n${result.stderr}`);
  });
}
