#!/bin/sh
# The canvas image: copies the build for VITE_AUTH_PROVIDER to /tmp/site, sets
# its runtime values, then serves it with Caddy on :8080.
set -eu
. /app/guard.sh
. /app/runtime-config.sh
guard_dev_auth
guard_auth
: "${VITE_SPACETIME_URI:?set VITE_SPACETIME_URI (wss://<domain>)}" "${VITE_SPACETIME_DB:?set VITE_SPACETIME_DB}"
rm -rf /tmp/site
cp -R "/app/site/${VITE_AUTH_PROVIDER:-anonymous}" /tmp/site
runtime_config /tmp/site spacetime_uri spacetime_db dashboard_url mcp_url oidc_issuer oidc_client_id require_auth
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
