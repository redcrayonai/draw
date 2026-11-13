import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeConfig } from './mcp-config.mjs';

test('removes hosted bindings regardless of formatting, preserving other config', () => {
  assert.deepEqual(composeConfig(`{
    // local settings
    "vars": { "URL": "https://example.com//path", "triggers": "keep" },
    "analytics_engine_datasets": [
      { "binding": "CALLS", "dataset": "rc_calls" }
    ],
    /* multiline hosted config */
    "triggers": {
      "crons": ["*/5 * * * *"]
    },
  }`), { vars: { URL: 'https://example.com//path', triggers: 'keep' } });
});

test('refuses malformed config', () => {
  assert.throws(() => composeConfig('{"triggers": ['));
});
