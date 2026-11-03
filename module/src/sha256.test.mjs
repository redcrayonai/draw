import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex } from './sha256.ts';

test('sha256Hex matches node:crypto across block boundaries and UTF-8', () => {
  const inputs = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(1000), 'héllo ✓ 𝄞 \u0000 "quoted"\n'];
  for (const s of inputs) assert.equal(sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s.slice(0, 20)));
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256Hex handles a multi-megabyte input', () => {
  const s = 'x'.repeat(3 * 1024 * 1024 + 7);
  assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'));
});
