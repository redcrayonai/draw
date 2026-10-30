#!/usr/bin/env node
// The production smoke (spec §9 step 12): /health is ok on the deployed sha,
// and one canary-style run (spec §10) on the board `_canary` works.
//
//   MCP_URL=https://mcp.<domain>/mcp CANARY_API_KEY=<canary's API key> EXPECTED_VERSION=<git sha> node mcp/scripts/smoke.mjs
//
// Locally, against `wrangler dev` with DEV_AUTH=1, leave CANARY_API_KEY unset.
// Exits 1 on any failure; deploy.yml then rolls back the Workers it deployed.
import { connect, healthy, need } from './client.mjs';

const mcpUrl = need('MCP_URL');
const version = process.env.EXPECTED_VERSION?.slice(0, 12);
const origin = new URL(mcpUrl).origin;

try {
  const health = await healthy(origin, version);
  console.log(`ok /health: ${JSON.stringify(health)}`);

  const { client, call } = await connect('v2', mcpUrl, process.env.CANARY_API_KEY);
  const ok = async (name, args) => {
    const r = await call(name, args);
    if (r.isError) throw new Error(`${name}: ${r.text}`);
    return r.text;
  };
  const board = String(JSON.parse(await ok('start_session', { name: '_canary' })).id);
  const snap = JSON.parse(await ok('get_board', { board }));
  // The first run on a fresh database draws the node every later run moves.
  let node = snap.nodes[0]?.id;
  if (node === undefined) {
    const made = await ok('create_node', { board, label: 'canary', sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'muted', focal: false });
    // The write can land while the id read fails ("committed (no new row observed…)"):
    // name the text, or the rollback this failure triggers says only "TypeError".
    node = /committed id=(\d+)/.exec(made)?.[1];
    if (!node) throw new Error(`create_node committed but named no id: ${made}`);
  }
  const x = snap.nodes[0]?.x === 0 ? 8 : 0;
  const moved = await ok('move_node', { board, nodeId: node, x, y: 0 });
  if (moved !== 'committed board=_canary') throw new Error(`move_node: ${moved}`);
  await client.close();
  console.log(`ok canary: start_session _canary (board ${board}), get_board (${snap.nodes.length} nodes), move_node ${node} to x=${x}`);
} catch (err) {
  console.error(`smoke FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
