// MCP clients of both protocol eras for e2e.mjs and smoke.mjs, against a
// deployed (or `wrangler dev`) mcp Worker. Every response's header names are
// collected in `headersSeen` for the allowlist check.
import { Client as ClientV2, StreamableHTTPClientTransport as TransportV2 } from '@modelcontextprotocol/client';
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as TransportV1 } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const headersSeen = new Set();

/** fetch, recording the response's header names. */
export async function fetchSeen(url, init) {
  const res = await fetch(url, init);
  res.headers.forEach((_, name) => headersSeen.add(name));
  return res;
}

/** The env value, or exit 2 naming it. */
export function need(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return value;
}

/** A connected client; `key` unset means the Worker runs with DEV_AUTH=1 (localhost only). */
export async function connect(era, mcpUrl, key) {
  const opts = { fetch: fetchSeen, requestInit: key ? { headers: { authorization: `Bearer ${key}` } } : {} };
  const client = era === 'v1' ? new ClientV1({ name: `redcrayon-${era}`, version: '1' }) : new ClientV2({ name: `redcrayon-${era}`, version: '1' });
  await client.connect(era === 'v1' ? new TransportV1(new URL(mcpUrl), opts) : new TransportV2(new URL(mcpUrl), opts));
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { text: res.content[0]?.text ?? '', isError: res.isError === true };
  };
  return { client, call };
}

/** GET /health until it is ok (and on `version`, when given) or `ms` pass: a deploy takes seconds to reach every location. */
export async function healthy(origin, version, ms = 60_000) {
  const until = Date.now() + ms;
  for (;;) {
    let last;
    try {
      const res = await fetchSeen(`${origin}/health`);
      const text = await res.text();
      last = `HTTP ${res.status} ${text.slice(0, 200)}`;
      const body = res.status === 200 ? JSON.parse(text) : undefined;
      if (body?.status === 'ok' && (!version || body.version === version)) return body;
    } catch (err) {
      last = String(err);
    }
    if (Date.now() > until) throw new Error(`/health is not ok${version ? ` on version ${version}` : ''} after ${ms / 1000} s; last: ${last}`);
    await new Promise(r => setTimeout(r, 3000));
  }
}
