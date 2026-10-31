// The load test: AGENTS agents, RATE calls a second each,
// for SECONDS, against an MCP URL; each agent draws on its own board. Prints
// per-tool p50/p95 client-side and the outcome counts. Server-side timings
// require separate instrumentation.
//
//   MCP_URL=https://staging.mcp.<domain>/mcp TOKENS=ak_1,ak_2 node mcp/scripts/load.mjs
//   MCP_URL=http://localhost:8788/mcp node mcp/scripts/load.mjs      # DEV_AUTH: no token
import { connect, prefix } from './mcp-call.mjs';

const url = process.env.MCP_URL ?? 'http://localhost:8788/mcp';
const agents = Number(process.env.AGENTS ?? 10);
const rate = Number(process.env.RATE ?? 2);
const seconds = Number(process.env.SECONDS ?? 300);
const tokens = (process.env.TOKENS ?? '').split(',').filter(Boolean);

const times = new Map();
const outcomes = new Map();
const record = (tool, r) => {
  (times.get(tool) ?? times.set(tool, []).get(tool)).push(r.ms);
  outcomes.set(prefix(r), (outcomes.get(prefix(r)) ?? 0) + 1);
};

async function agent(i) {
  const { client, call } = await connect(url, tokens[i % Math.max(tokens.length, 1)]);
  const start = await call('start_session', { name: `load-${i}` });
  if (start.isError) throw new Error(`agent ${i}: ${start.text}`);
  const board = String(JSON.parse(start.text).id);
  const made = await call('create_node', { board, label: `load ${i}`, sublabel: '', x: 0, y: 0, w: 160, h: 64, token: 'ink', focal: false });
  const nodeId = /committed id=(\d+)/.exec(made.text)?.[1];
  const until = Date.now() + seconds * 1000;
  for (let n = 0; Date.now() < until; n++) {
    const next = Date.now() + 1000 / rate;
    const r = n % 4 === 0 ? await call('get_board', { board }) : await call('move_node', { board, nodeId, x: (n % 2) * 8, y: 0 });
    record(n % 4 === 0 ? 'get_board' : 'move_node', r);
    await new Promise(res => setTimeout(res, Math.max(0, next - Date.now())));
  }
  await client.close();
}

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
await Promise.all(Array.from({ length: agents }, (_, i) => agent(i)));
for (const [tool, xs] of times) console.log(`${tool}: ${xs.length} calls, p50 ${pct(xs, 50)} ms, p95 ${pct(xs, 95)} ms (client-side)`);
console.log('outcomes', Object.fromEntries(outcomes));
