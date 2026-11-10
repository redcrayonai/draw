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
# Plugin canvas settings (one name per line): set as <NAME>, from plugins.env like the dashboard's.
plugin_settings=''
while read -r name; do
  [ -n "$name" ] || continue
  case "$name" in [!A-Z]* | *[!A-Z0-9_]*) die "canvas-settings: '$name' is not a setting name" ;; esac
  eval "[ -n \"\${VITE_$name:-}\" ] || export VITE_$name=\"\${$name:-}\""
  plugin_settings="$plugin_settings $(echo "$name" | tr A-Z a-z)"
done </app/canvas-settings
# shellcheck disable=SC2086 # one word per setting name
runtime_config /tmp/site spacetime_uri spacetime_db dashboard_url mcp_url oidc_issuer oidc_client_id require_auth $plugin_settings
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
