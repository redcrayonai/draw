import { accounts } from '$auth';
import { readMcpUrl } from '../../shared/connect-guide';
import { pickDb } from '../../shared/db-target';
import { readPrivacyUrl } from '../../shared/privacy-url';

const uri: unknown = import.meta.env.VITE_SPACETIME_URI;
const db: unknown = import.meta.env.VITE_SPACETIME_DB;
const requireAuth: unknown = import.meta.env.VITE_REQUIRE_AUTH;
const dashboardUrl: unknown = import.meta.env.VITE_DASHBOARD_URL;
const authRequired = typeof requireAuth === 'string' && ['1', 'true'].includes(requireAuth.toLowerCase());

if (typeof uri !== 'string' || uri.length === 0) {
  throw new Error('VITE_SPACETIME_URI is not set — add it to client/.env');
}
if (typeof db !== 'string' || db.length === 0) {
  throw new Error('VITE_SPACETIME_DB is not set — add it to client/.env');
}
// Fail loud rather than silently deploying an ungated board: a deployment
// that intends to require sign-in sets VITE_REQUIRE_AUTH=1 alongside its
// VITE_AUTH_PROVIDER, so an anonymous build or a provider missing its settings
// breaks at startup instead of falling back to anonymous mode.
if (authRequired && !accounts) {
  throw new Error(
    'VITE_REQUIRE_AUTH is set but this build has no sign-in (VITE_AUTH_PROVIDER) — refusing to start without the sign-in gate'
  );
}

// ?db=<name> points this page at another database on the same server, but
// only one listed in VITE_SPACETIME_DB_ALLOWED (unset in production builds).
export const config = {
  uri,
  db: pickDb(location.search, db, import.meta.env.VITE_SPACETIME_DB_ALLOWED),
  defaultDb: db,
  // Set when the auth provider has accounts; undefined = guests only.
  accounts,
  // With accounts, sign-in is optional by default (Excalidraw-style:
  // board loads anonymously, sign in from the header). Setting
  // VITE_REQUIRE_AUTH gates the whole app behind sign-in instead.
  requireAuth: authRequired,
  // Dashboard origin for the "Boards" link back (mirror of the dashboard's
  // VITE_CANVAS_URL). Optional: unset hides the link instead of failing boot.
  dashboardUrl:
    typeof dashboardUrl === 'string' && dashboardUrl.length > 0 ? dashboardUrl : undefined,
  // The hosted agent server, e.g. https://mcp.example.com/mcp, which the
  // Connect dialog's snippets carry. Optional until the domain lands: unset
  // (or a local one in a production build) hides every Connect opener.
  mcpUrl: readMcpUrl(import.meta.env.VITE_MCP_URL, import.meta.env.PROD),
  // The hosted privacy policy, linked from the code panel and the Connect dialog. Unset = no link.
  privacyUrl: readPrivacyUrl(import.meta.env.VITE_PRIVACY_URL),
  // A hosted build sets VITE_PREVIEW=1 to tag the header Preview.
  preview: import.meta.env.VITE_PREVIEW === '1',
};
