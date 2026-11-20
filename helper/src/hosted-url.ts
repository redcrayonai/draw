import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { DEFAULT_ORIGIN } from './capture';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

/** The plugin ships `${REDCRAYON_MCP_URL:-<default>}`; no client expands it, so it is never valid to save. */
const PLACEHOLDER = /^\$\{REDCRAYON_MCP_URL:-(.*)\}$/;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/;

/** The URL itself when it is an absolute HTTP(S) URL (HTTP only on localhost), else undefined. */
export function validMcpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  let url: URL;
  try { url = new URL(text); } catch { return undefined; }
  if (url.username || url.password || url.hash || !url.hostname) return undefined;
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOST.test(url.hostname))) return text;
  return undefined;
}

const reject = (what: string, value: string) => new Error(`REJECTED: ${what} "${value}" is not a valid Draw instance URL; use an absolute https:// URL (http:// only for localhost).`);

/** The default the packaged plugin advertises (the production endpoint in a release). */
export function packagedDefault(config: any): string {
  const raw = config?.mcpServers?.draw?.url;
  const url = validMcpUrl(typeof raw === 'string' ? raw.replace(PLACEHOLDER, '$1') : raw);
  if (!url) throw new Error('UNAVAILABLE: this Draw build has no valid default instance URL; pass --url <https://...>.');
  return url;
}

/** The endpoint already installed for this agent; a legacy placeholder or garbage counts as absent. */
export function installedUrl(activeDirectory: string): { url?: string; legacy: boolean } {
  try {
    const server = JSON.parse(readFileSync(join(activeDirectory, '.mcp.json'), 'utf8'))?.mcpServers?.draw;
    const raw = server?.env?.REDCRAYON_MCP_URL ?? server?.url;
    const url = validMcpUrl(raw);
    return { url, legacy: !url && typeof raw === 'string' };
  } catch { return { legacy: false }; }
}

/** Precedence: --url, REDCRAYON_MCP_URL, installed endpoint, packaged default. Explicit but invalid input fails loudly. */
export function resolveMcpUrl(input: { flag?: string; env?: string; installed?: string; fallback: () => string }): { url: string; source: string } {
  if (input.flag !== undefined) {
    const url = validMcpUrl(input.flag); if (!url) throw reject('--url', input.flag);
    return { url, source: '--url' };
  }
  if (input.env) {
    const url = validMcpUrl(input.env); if (!url) throw reject('REDCRAYON_MCP_URL', input.env);
    return { url, source: 'REDCRAYON_MCP_URL' };
  }
  if (input.installed) return { url: input.installed, source: 'existing installation' };
  return { url: input.fallback(), source: 'default' };
}

/** aws-configure style: Enter keeps the default, anything else is validated and re-asked until valid. */
export async function promptMcpUrl(fallback: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write('\nEnter the MCP endpoint of your Draw instance, or press Enter to use the default shown.\n');
    for (;;) {
      const answer = (await terminal.question(`Draw instance URL [${fallback}]: `)).trim();
      if (!answer) return fallback;
      const url = validMcpUrl(answer);
      if (url) return url;
      process.stderr.write('Enter an absolute https:// URL (http:// is allowed only for localhost).\n');
    }
  } finally { terminal.close(); }
}

export function installedEndpoints() {
  return new Set(['codex', 'claude-code', 'pi'].flatMap(agent =>
    installedUrl(join(homedir(), '.redcrayon/plugins/installed', agent + '-hosted')).url ?? []));
}

// A custom MCP endpoint does not tell us where its dashboard is hosted.
export function sharingInstance(endpoint = process.env.REDCRAYON_MCP_URL) {
  if (!endpoint) {
    const saved = installedEndpoints();
    if (saved.size > 1) return 'your chosen Draw instance';
    endpoint = [...saved][0];
  }
  if (!endpoint || endpoint === DEFAULT_ORIGIN + '/mcp') return '';
  return validMcpUrl(endpoint) ? new URL(endpoint).host : 'your chosen Draw instance';
}

export function localViewerUrl(href: string, instance: string) {
  const url = new URL(href);
  url.searchParams.set('instance', instance);
  return url.href;
}
