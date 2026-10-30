// node docker/prod/ratelimit.test.mjs
import assert from 'node:assert/strict';
import rateLimit from './ratelimit.js';

const rl = rateLimit({ limit: 2, period: 60 });
const ok = async key => (await rl.limit({ key })).success;
assert.equal(await ok('a'), true);
assert.equal(await ok('a'), true);
assert.equal(await ok('a'), false, 'third call in the window is refused');
assert.equal(await ok('b'), true, 'keys are counted apart');

const realNow = Date.now;
Date.now = () => realNow() + 60_000;
assert.equal(await ok('a'), true, 'a new window resets the count');
Date.now = realNow;
console.log('ratelimit ok');
