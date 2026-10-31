// The agent half of the self-host smoke (smoke.sh), with no dependencies:
//   node agent.mjs draw <mcp url> <key>             start_session, create_node, get_board, then a capture upload
//   node agent.mjs check <mcp url> <key> <capture>  start_session again, get_board, then claim the capture
// Prints one JSON line: { board, nodes, capture } or { board, nodes, claim }.
// The capture lives in the mcp Worker's Durable Object storage: after a restart,
// a stored one is refused for its contents, a lost one as "expired or was already used".
const [mode, url, key, capture] = process.argv.slice(2);
let id = 0;
async function call(name, args) {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.text();
  const data = body.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('') || body;
  const msg = JSON.parse(data);
  const text = msg.result?.content?.[0]?.text ?? msg.error?.message ?? '';
  return { ok: res.ok && !msg.error && !msg.result?.isError, text };
}
async function must(name, args) {
  const r = await call(name, args);
  if (!r.ok) throw new Error(`${name}: ${r.text}`);
  return r.text;
}

const board = String(JSON.parse(await must('start_session', { name: 'compose-prod-smoke' })).id);
if (mode === 'draw') await must('create_node', { board, label: 'smoke', sublabel: 'compose.prod.yml', x: 0, y: 0, w: 160, h: 64, token: 'muted', focal: false });
const nodes = JSON.parse(await must('get_board', { board })).nodes.length;
if (mode === 'draw') {
  // A shape-valid upload the Capture Durable Object stores as is.
  const res = await fetch(`${url}/facts`, { method: 'POST', body: JSON.stringify({ kind: 'start' }) });
  if (!res.ok) throw new Error(`POST /facts: ${res.status} ${await res.text()}`);
  console.log(JSON.stringify({ board, nodes, capture: (await res.json()).capture }));
} else {
  const claim = await call('start_session', { name: 'compose-prod-smoke', capture });
  console.log(JSON.stringify({ board, nodes, claim: /expired or was already used/.test(claim.text) ? 'lost' : 'stored' }));
}
