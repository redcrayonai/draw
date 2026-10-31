#!/bin/sh
# workerd-entrypoint.sh <mcp|dashboard>: refuses unsafe settings, reads what
# module-setup generated from /state, assembles /tmp/run (the config with this
# container's networks in its allow-list, the Worker, the dashboard's runtime
# values), runs workerd.
set -eu
. /app/guard.sh
. /app/runtime-config.sh
guard_dev_auth
app=${1:-}
networks="$(own_networks | sed 's/.*/"&"/' | paste -sd, -)"
[ -n "$networks" ] || die "this container is on no network."
state() {
  [ -r "/state/$1" ] || die "/state/$1 is missing: module-setup writes it (compose.prod.yml runs it first)."
  cat "/state/$1"
}
run=/tmp/run
rm -rf "$run" && mkdir -p "$run"
case "$app" in
  mcp)
    guard_api_keys
    : "${MCP_ORIGIN:?}" "${APP_ORIGIN:?}" "${DB_URL:?}" "${DB_NAME:?}"
    [ -n "${OIDC_ISSUER:-}${MCP_API_KEYS:-}" ] || echo "mcp: no VITE_OIDC_ISSUER and no MCP_API_KEYS, so no agent can sign in; add a key (.env.example)." >&2
    # Without sign-in there is no issuer, but the Worker builds URLs from one; API keys still work.
    export OIDC_ISSUER="${OIDC_ISSUER:-https://oidc.invalid}"
    [ -n "${AGENT_JWK:-}" ] || AGENT_JWK="$(state agent-jwk.json)"
    export AGENT_JWK
    cp /app/mcp/worker.js /app/ratelimit.js "$run/"
    ;;
  dashboard)
    guard_auth
    guard_secret POSTGRES_PASSWORD IMPORT_RUNNER_SECRET
    : "${SPACETIMEDB_URL:?}" "${SPACETIMEDB_DB:?}" "${VITE_SPACETIME_URI:?}"
    export DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@${POSTGRES_HOST:-postgres}:5432/redcrayon?sslmode=disable"
    # Who may import: the browser's issuer; with none, nobody unless IMPORTS_ANONYMOUS=1.
    if [ "${VITE_AUTH_PROVIDER:-anonymous}" = oidc ]; then export OIDC_ISSUER="$VITE_OIDC_ISSUER"; else unset OIDC_ISSUER; fi
    [ -n "${SPACETIMEDB_SERVICE_TOKEN:-}" ] || SPACETIMEDB_SERVICE_TOKEN="$(state service-token)"
    export SPACETIMEDB_SERVICE_TOKEN
    cp -R "/app/dashboard/${VITE_AUTH_PROVIDER:-anonymous}/." "$run/"
    cp /app/assets.js "$run/"
    runtime_config "$run" spacetime_uri spacetime_db canvas_url mcp_url oidc_issuer oidc_client_id
    ;;
  *) die "usage: workerd-entrypoint.sh <mcp|dashboard>" ;;
esac
sed "s|\"@NETWORKS@\"|$networks|" "/app/$app.capnp" >"$run/config.capnp"
cd "$run"
exec workerd serve config.capnp
