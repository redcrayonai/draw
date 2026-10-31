#!/usr/bin/env node
// Points the plugin and the helper at a deployment's domain:
//
//   node scripts/plugin-config.mjs https://mcp.<domain>
//
// Rewrites the server URL (https://mcp.<domain>/mcp), the helper's origin and
// the support address (support@<domain>) wherever they appear in FILES. The
// current domain is read from plugin/.mcp.json, so the command can run again to
// move domains. release-plugin.yml refuses to release the placeholder domain
// redcrayon.invalid.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PLACEHOLDER = 'redcrayon.invalid';
// plugin/.mcp.json first: it holds the current domain. helper/ is skipped where it is not checked out.
export const FILES = ['plugin/.mcp.json', 'plugin/README.md', 'helper/src/capture.ts'];

/** The domain behind an MCP origin `https://mcp.<domain>`, or an error naming the expected form. */
export function domainOf(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`not a URL: ${origin}; pass the MCP origin, e.g. https://mcp.example.com`);
  }
  if (url.protocol !== 'https:' || !url.hostname.startsWith('mcp.') || url.port || url.pathname !== '/' || url.search || url.hash || url.username) {
    throw new Error(`expected https://mcp.<domain> with no path, got ${origin}`);
  }
  return url.hostname.slice('mcp.'.length);
}

/** The hosted server URL in plugin/.mcp.json: the default of its `${REDCRAYON_MCP_URL:-…}`, which a self-hoster sets. */
export const hostedUrl = mcpJson => mcpJson.mcpServers.draw.url.replace(/^\$\{REDCRAYON_MCP_URL:-(.*)\}$/, '$1');

export function configure(root, origin) {
  const domain = domainOf(origin);
  const currentOrigin = new URL(hostedUrl(JSON.parse(readFileSync(join(root, FILES[0]), 'utf8')))).origin;
  const current = currentOrigin === 'http://localhost:8788' ? 'localhost:8788' : domainOf(currentOrigin);
  const changed = [];
  for (const file of FILES) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, text.replaceAll(currentOrigin, new URL(origin).origin).replace(/support@[a-z0-9.-]+\.[a-z]+/g, `support@${domain}`));
    changed.push(file);
  }
  return { from: current, to: domain, changed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { from, to, changed } = configure(new URL('..', import.meta.url).pathname, process.argv[2] ?? '');
    console.error(`plugin-config: ${from} → ${to} in ${changed.join(', ')}`);
  } catch (err) {
    console.error(`plugin-config: ${err.message}`);
    process.exit(1);
  }
}
