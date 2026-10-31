import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requiredJobs, failedJobs, fullJobs, needsFull } from './ci-ready.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ci = () => read('.github/workflows/ci.yml');
const job = (workflow, name) => {
  const block = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|$(?![\\s\\S]))`, 'm'));
  assert.ok(block, `missing ${name} job`);
  return block[1];
};
const needs = block => block.match(/^    needs: (.+)$/m)?.[1].replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).sort();

test('ci-ready requires every prerequisite, including missing and skipped results', () => {
  const results = Object.fromEntries(requiredJobs.map(name => [name, { result: 'success' }]));
  const status = needs => spawnSync(process.execPath, [fileURLToPath(new URL('./ci-ready.mjs', import.meta.url))], {
    env: { CI_NEEDS: JSON.stringify(needs) },
  }).status;
  assert.deepEqual(failedJobs(results), []);
  assert.equal(status(results), 0);
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    const changed = { ...results, e2e: { result } };
    assert.deepEqual(failedJobs(changed), ['e2e']);
    assert.equal(status(changed), 1);
  }
  delete results.e2e;
  assert.deepEqual(failedJobs(results), ['e2e']);
  assert.equal(status(results), 1);
});

test('a PR touching only markdown, GitHub YAML or scripts runs the light jobs; anything else, or main, runs everything', () => {
  for (const files of [['.github/workflows/release-labels.yml', 'scripts/release-labels.mjs'], ['README.md', 'docs/src/content/docs/index.md'], ['.github/dependabot.yml'], ['scripts/stdb-test.sh'], ['helper/scripts/x.mjs', 'mcp/scripts/smoke.mjs']]) {
    assert.equal(needsFull(files), false, files.join(', '));
  }
  for (const files of [[], ['client/src/main.ts'], ['scripts/x.mjs', 'client/src/main.ts'], ['plugin/skills/draw/SKILL.md'], ['.github/actions/spacetime/action.yml'], ['docker/compose.yml'], ['pnpm-lock.yaml']]) {
    assert.equal(needsFull(files), true, files.join(', '));
  }
  assert.deepEqual(requiredJobs.filter(name => !fullJobs.includes(name)), ['workflow-checks', 'secret-scan']);
  const results = { ...Object.fromEntries(requiredJobs.map(name => [name, { result: 'success' }])), ...Object.fromEntries(fullJobs.map(name => [name, { result: 'skipped' }])), 'secret-scan': { result: 'success' } };
  assert.deepEqual(failedJobs({ ...results, changes: { result: 'success', outputs: { full: 'false' } } }), []);
  assert.deepEqual(failedJobs({ ...results, 'secret-scan': { result: 'skipped' }, changes: { result: 'success', outputs: { full: 'false' } } }), ['secret-scan']);
  assert.deepEqual(failedJobs({ ...results, changes: { result: 'success', outputs: { full: 'true' } } }), fullJobs);
  assert.deepEqual(failedJobs({ ...results, changes: { result: 'failure', outputs: { full: 'false' } } }), ['changes']);
  const main = read('.github/workflows/ci.yml').match(/^  changes:\n[\s\S]*?(?=^  [\w-]+:\n)/m)[0];
  assert.match(main, /if \[ "\$GITHUB_EVENT_NAME" = pull_request \]; then[\s\S]*else\n\s+echo full=true/);
});

test('every PR and main commit runs the reusable quality gate', () => {
  const workflow = ci();
  assert.match(workflow, /^on:\n  pull_request:\n  workflow_call:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+paths(?:-ignore)?:/m);
  const declared = [...workflow.slice(workflow.indexOf('\njobs:\n')).matchAll(/^  ([\w-]+):$/gm)].map(m => m[1]);
  for (const name of [...requiredJobs, 'ci-ready']) assert.ok(declared.includes(name), `missing ${name} job`);
  for (const name of requiredJobs.filter(name => name !== 'workflow-checks')) {
    const file = `${name}.yml`;
    const block = job(workflow, name);
    assert.match(block, new RegExp(`uses: \\./\\.github/workflows/${file.replaceAll('.', '\\.')}\\s*$`, 'm'));
    if (fullJobs.includes(name)) {
      assert.ok(needs(block).includes('changes'), `${name} must need changes`);
      assert.deepEqual(block.match(/^    (?:if|continue-on-error):.*$/gm), ["    if: needs.changes.outputs.full == 'true'"]);
    } else {
      assert.doesNotMatch(block, /^    (?:if|continue-on-error):/m);
    }
    assert.match(read(`.github/workflows/${file}`), /^  workflow_call:/m, `${file} must support workflow_call`);
  }
  const ready = job(workflow, 'ci-ready');
  assert.match(ready, /^    name: ci-ready$/m);
  assert.deepEqual(needs(ready), declared.filter(name => name !== 'ci-ready').sort());
  assert.match(ready, /^    if: \$\{\{ always\(\) \}\}$/m);
  assert.match(ready, /CI_NEEDS: \$\{\{ toJSON\(needs\) \}\}/);
  assert.match(ready, /run: node scripts\/ci-ready\.mjs/);
  const checks = job(workflow, 'workflow-checks');
  assert.match(checks, /node --test scripts\/ci-workflows\.test\.mjs/);
  assert.match(checks, /scripts\/check-wire-compat\.test\.mjs/);
  assert.match(checks, /scripts\/module-env\.test\.mjs/);
  // A scripts-only PR runs no other job, so every scripts/ test runs here.
  for (const dir of ['scripts']) {
    for (const file of readdirSync(new URL(`../${dir}`, import.meta.url)).filter(file => file.endsWith('.test.mjs'))) {
      assert.ok(checks.split(/\s+/).includes(`${dir}/${file}`), `${dir}/${file} must run in workflow-checks`);
    }
  }
  assert.match(checks, /actionlint/);
});

test('PR and main events each enter CI once; leaf checks only run through their caller', () => {
  const events = workflow => [...workflow.match(/^on:\n([\s\S]*?)(?=^\S)/m)[1].matchAll(/^  ([\w_]+):/gm)].map(([, event]) => event).sort();
  assert.deepEqual(events(ci()), ['pull_request', 'workflow_call', 'workflow_dispatch']);
  for (const name of requiredJobs.filter(name => name !== 'workflow-checks')) {
    const workflow = read(`.github/workflows/${name}.yml`);
    assert.deepEqual(events(workflow), name === 'security-scan' ? ['schedule', 'workflow_call'] : ['workflow_call'], `${name} must not start a duplicate standalone suite`);
  }
  assert.match(read('.github/workflows/security-scan.yml'), /schedule:\n    - cron: '0 14 \* \* 1'/);
});

test('app builds share the aggregate bindings check instead of starting two more', () => {
  for (const name of ['build-client', 'build-web']) {
    assert.deepEqual(needs(job(ci(), name)), ['bindings-check', 'changes']);
    assert.doesNotMatch(read(`.github/workflows/${name}.yml`), /uses: \.\/\.github\/workflows\//);
    assert.equal(needs(job(read(`.github/workflows/${name}.yml`), 'build')), undefined);
  }
});

test('module CI checks charts and preserves the live upgrade contract', () => {
  assert.match(read('.github/workflows/module-tests.yml'), /scripts\/stdb-test\.sh run scripts\/verify-architecture-local\.mjs scripts\/verify-charts-local\.mjs/);
  assert.match(read('.github/workflows/module-tests.yml'), /fetch-depth: 0/);
  assert.match(read('.github/workflows/module-tests.yml'), /run: scripts\/check-module-upgrade\.sh/);
});

test('ci-ready requires every additional caller prerequisite', () => {
  const results = Object.fromEntries(requiredJobs.map(name => [name, { result: 'success' }]));
  assert.deepEqual(failedJobs(results), []);
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    assert.deepEqual(failedJobs({ ...results, extension: { result } }), ['extension']);
  }
  assert.deepEqual(failedJobs({ ...results, extension: { result: 'success' } }), []);
});

test('local module publishers backfill board slugs after publication', () => {
  for (const script of ['scripts/dev.sh', 'scripts/dev-dashboard.sh', 'docker/prod/module-setup.sh']) {
    const text = read(script);
    const published = text.search(/spacetime publish |publish-module\.sh\n/);
    assert.ok(published !== -1 && text.indexOf('/call/backfill_board_slugs') > published, `${script} runs backfill_board_slugs after its publish`);
  }
  // docker/setup.sh publishes through scripts/dev-dashboard.sh
  assert.match(read('docker/setup.sh'), /scripts\/dev-dashboard\.sh/);
});

test('public wrangler configs contain local settings only', () => {
  for (const dir of ['client', 'mcp', 'web']) {
    const text = read(`${dir}/wrangler.jsonc`);
    assert.doesNotMatch(text, /"routes"|"route"|"account_id"|"env"/, `${dir}/wrangler.jsonc must stay dev-only`);
    const config = JSON.parse(text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (_, string) => string ?? ''));
    assert.ok(config.name.endsWith('-local'), `${dir}/wrangler.jsonc must name a local Worker`);
  }
});
