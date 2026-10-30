// scripts/module-env.mjs: the issuers a publish writes into module/src/issuers.ts.
//   node --test scripts/module-env.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../module/src/issuers.ts', import.meta.url));
const SCRIPT = fileURLToPath(new URL('./module-env.mjs', import.meta.url));

// The ISSUERS a command run under `module-env <variant> --` sees; the committed `none` file comes back after.
function issuersDuring(variant, env) {
  const print = `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(FILE)}, 'utf8'))`;
  const run = spawnSync(process.execPath, [SCRIPT, variant, '--', process.execPath, '-e', print], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(readFileSync(FILE, 'utf8'), /"variant": "none"/, 'module-env writes the none variant back');
  return JSON.parse(run.stdout.slice(run.stdout.indexOf('} = ') + 4).trim().replace(/;$/, ''));
}

test('BROWSER_ISSUER reaches the module byte for byte: the module compares it with a token iss exactly', () => {
  assert.equal(issuersDuring('production', { BROWSER_ISSUER: 'https://acme.auth0.com/' }).browser, 'https://acme.auth0.com/');
  assert.equal(issuersDuring('local', { BROWSER_ISSUER: 'http://127.0.0.1:3101/browser' }).browser, 'http://127.0.0.1:3101/browser');
});

test('RC-571: staging and production enforce the allowlist, local only logs; the database issuers default to localhost', () => {
  for (const variant of ['staging', 'production']) assert.equal(issuersDuring(variant, {}).enforce, true, variant);
  assert.equal(issuersDuring('local', {}).enforce, false);
  assert.deepEqual(issuersDuring('production', { DB_ISSUERS: '' }).dbIssuers, ['localhost']);
  assert.deepEqual(issuersDuring('staging', { DB_ISSUERS: 'localhost, https://login.example ,localhost' }).dbIssuers, ['localhost', 'https://login.example']);
  assert.deepEqual(issuersDuring('none', { DB_ISSUERS: 'localhost' }).dbIssuers, [], 'none accepts no issuer at all');
});

test('REDCRAYON_LIMITS: storage limits are off unless a publish turns them on', () => {
  for (const variant of ['local', 'staging', 'production']) {
    assert.equal(issuersDuring(variant, { REDCRAYON_LIMITS: '' }).limits, false, variant);
    assert.equal(issuersDuring(variant, { REDCRAYON_LIMITS: 'on' }).limits, true, variant);
  }
  assert.equal(issuersDuring('production', { REDCRAYON_LIMITS: 'off' }).limits, false);
  assert.equal(issuersDuring('none', { REDCRAYON_LIMITS: 'off' }).limits, true, 'none ignores it: nothing connects to it');
  const run = spawnSync(process.execPath, [SCRIPT, 'production', '--', process.execPath, '-e', ''], { env: { ...process.env, REDCRAYON_LIMITS: 'false' }, encoding: 'utf8' });
  assert.notEqual(run.status, 0, 'a typo refuses to publish instead of guessing');
  assert.match(readFileSync(FILE, 'utf8'), /"variant": "none"/);
});
