import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readTokenAt, saveTokenAt, tokenPathFor } from './identity';

test('anonymous token files round-trip with owner-only permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-importer-identity-'));
  const path = join(dir, 'nested', 'token');
  try {
    assert.equal(readTokenAt(path), undefined);
    saveTokenAt(path, 'server-issued-test-token');
    assert.equal(readTokenAt(path), 'server-issued-test-token');
    assert.equal(readFileSync(path, 'utf8'), 'server-issued-test-token\n');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    chmodSync(path, 0o644);
    saveTokenAt(path, 'server-issued-test-token', 'server-issued-test-token');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    writeFileSync(path, '   \n');
    assert.equal(readTokenAt(path), undefined);
    assert.throws(() => readTokenAt(dir), /EISDIR/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('simultaneous first connections preserve the winning anonymous identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-importer-identity-race-'));
  const path = join(dir, 'token');
  const identityModule = new URL('./identity.ts', import.meta.url).href;
  const children = ['first-token', 'second-token'].map(token => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { readTokenAt, saveTokenAt } from ${JSON.stringify(identityModule)};
      const [path, token] = process.argv.slice(1);
      const saved = readTokenAt(path);
      process.send({ ready: true, missing: saved === undefined });
      process.once('message', () => {
        try {
          saveTokenAt(path, token, saved);
          process.send({ saved: true, token });
        } catch {
          process.send({ saved: false });
        }
        process.disconnect();
      });
    `, path, token], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const ready = new Promise<void>((resolve, reject) => {
      child.once('message', message => {
        assert.deepEqual(message, { ready: true, missing: true });
        resolve();
      });
      child.once('error', reject);
      child.once('exit', code => { if (code !== 0) reject(new Error(`identity process exited ${code}`)); });
    });
    const result = new Promise<{ saved: boolean; token?: string }>((resolve, reject) => {
      child.on('message', message => {
        const value = message as { saved?: boolean; token?: string };
        if (value.saved !== undefined) resolve(value as { saved: boolean; token?: string });
      });
      child.once('error', reject);
      child.once('exit', code => { if (code !== 0) reject(new Error(`identity process exited ${code}`)); });
    });
    return { child, ready, result };
  });
  try {
    await Promise.all(children.map(({ ready }) => ready));
    children.forEach(({ child }) => child.send('save'));
    const results = await Promise.all(children.map(({ result }) => result));
    const winners = results.filter(result => result.saved);
    assert.equal(winners.length, 1);
    assert.equal(readTokenAt(path), winners[0].token);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    children.forEach(({ child }) => child.kill());
    rmSync(dir, { recursive: true, force: true });
  }
});

test('established connections cannot replace or restore a changed identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-importer-identity-change-'));
  const path = join(dir, 'token');
  try {
    saveTokenAt(path, 'original-token');
    const saved = readTokenAt(path);
    assert.throws(() => saveTokenAt(path, 'different-token', saved), /identity.*changed/i);
    assert.equal(readTokenAt(path), 'original-token');
    writeFileSync(path, 'other-command-token\n');
    assert.throws(() => saveTokenAt(path, 'original-token', saved), /identity.*changed/i);
    assert.equal(readTokenAt(path), 'other-command-token');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('default identities belong to one server host and span its databases', () => {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const local = join(root, '.context', 'importer-token.localhost');
  for (const uri of ['ws://localhost:3000', 'WS://LocalHost:3001', 'ws://127.0.0.1:3000', 'ws://[::1]:3000']) {
    assert.equal(tokenPathFor(uri), local);
  }
  const remote = tokenPathFor('wss://Db.Example');
  assert.equal(remote, join(root, '.context', 'importer-token.db.example'));
  assert.notEqual(remote, local);
  assert.notEqual(tokenPathFor('ws://10.0.0.7:3000'), local);
});

test('explicit token files resolve from the CLI working directory', () => {
  assert.equal(tokenPathFor('ws://localhost:3000', '../owner-token'), resolve('../owner-token'));
  assert.equal(tokenPathFor('wss://another.example', '/tmp/authorized-token'), '/tmp/authorized-token');
});
