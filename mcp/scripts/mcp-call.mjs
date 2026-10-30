// A tiny MCP client for the drills and the load test: one session per agent,
// over the 2026-07-28 client (it falls back to 2025-era serving by itself).
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export async function connect(url, token) {
  const client = new Client({ name: 'redcrayon-drill', version: '1' });
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  const call = async (name, args = {}) => {
    const started = Date.now();
    try {
      const res = await client.callTool({ name, arguments: args });
      return { text: res.content[0]?.text ?? '', isError: res.isError === true, ms: Date.now() - started };
    } catch (err) {
      return { text: `transport: ${err.message}`, isError: true, ms: Date.now() - started };
    }
  };
  return { client, call };
}

export const prefix = r => (r.isError ? r.text.split(':')[0] : 'ok');
