import { accounts } from '$auth';
import { readMcpUrl } from '$shared/connect-guide';
import { pickDb } from '$shared/db-target';
import { readPrivacyUrl } from '$shared/privacy-url';

// VITE_REQUIRE_AUTH is a boolean flag: only the documented enable values
// ('1' or 'true') turn the gate on. Any other value — including '0', 'false',
// or whitespace — leaves it off, so a false-like value can never accidentally
// gate the dashboard or hard-fail startup.
export function parseRequireAuth(v: unknown): boolean {
  return typeof v === 'string' && (v.trim() === '1' || v.trim().toLowerCase() === 'true');
}

// SpacetimeDB target (same contract as client/src/config.ts) plus the canvas
// base URL for "Open in canvas" links. `search` is location.search: ?db=<name>
// points the dashboard at another database on the same server, if listed in
// VITE_SPACETIME_DB_ALLOWED (unset in production builds).
export function readSpacetime(env: Record<string, unknown>, search: string) {
  const uri = env.VITE_SPACETIME_URI;
  const db = env.VITE_SPACETIME_DB;
  const canvasUrl = env.VITE_CANVAS_URL;
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new Error('VITE_SPACETIME_URI is not set — add it to web/.env.local (e.g. ws://localhost:3000)');
  }
  if (typeof db !== 'string' || db.length === 0) {
    throw new Error('VITE_SPACETIME_DB is not set — add it to web/.env.local (e.g. redcrayon-dash)');
  }
  return {
    spacetimeUri: uri,
    spacetimeDb: pickDb(search, db, env.VITE_SPACETIME_DB_ALLOWED),
    canvasUrl:
      typeof canvasUrl === 'string' && canvasUrl.length > 0 ? canvasUrl : 'http://localhost:5173',
  };
}

const requireAuth = parseRequireAuth(import.meta.env.VITE_REQUIRE_AUTH);

// With accounts every route requires sign-in (+layout.svelte). VITE_REQUIRE_AUTH
// only makes an anonymous build, or a provider missing its settings, fail loud.
if (requireAuth && !accounts) {
  throw new Error(
    'VITE_REQUIRE_AUTH is set but this build has no sign-in (VITE_AUTH_PROVIDER) — refusing to start without the sign-in gate'
  );
}

export const config = {
  ...readSpacetime(import.meta.env, location.search),
  // Set when the auth provider has accounts; undefined = anonymous dev mode.
  accounts,
  // The hosted agent server, e.g. https://mcp.example.com/mcp, for the agent
  // setup page. Optional until the domain lands: unset hides the setup.
  mcpUrl: readMcpUrl(import.meta.env.VITE_MCP_URL, import.meta.env.PROD),
  // The hosted privacy policy, linked under the code setting. Unset = no link.
  privacyUrl: readPrivacyUrl(import.meta.env.VITE_PRIVACY_URL),
  // A hosted build sets VITE_PREVIEW=1 to tag the logo Preview.
  preview: import.meta.env.VITE_PREVIEW === '1',
  previewNote: 'Draw is in preview. The hosted version is free while it lasts.',
};
