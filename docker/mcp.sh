#!/bin/sh
# docker-compose.yml's mcp service. Sign-in comes from this container's own
# environment, so a changed .env recreates it; setup's vars hold the rest.
set -eu
{
  # a volume from before docker/mcp.sh holds DEV_AUTH=1 here
  grep -v '^DEV_AUTH=' /state/mcp.dev.vars
  # DEV_AUTH only while no real sign-in is set: it makes every localhost caller user_dev, keys or not.
  [ -n "${MCP_API_KEYS:-}${OIDC_ISSUER:-}" ] || echo DEV_AUTH=1
  [ -z "${MCP_API_KEYS:-}" ] || echo "MCP_API_KEYS=$MCP_API_KEYS"
  [ -z "${OIDC_ISSUER:-}" ] || echo "OIDC_ISSUER=$OIDC_ISSUER"
} >.dev.vars
# No Analytics Engine dataset and no cron (the canary): both are hosted-only.
# shortcut: sed drops their one-line entries; a multi-line rewrite of either breaks this start, which compose-smoke.yml catches.
sed '/"analytics_engine_datasets"/d; /"triggers"/d' wrangler.jsonc >wrangler.compose.jsonc
exec pnpm exec wrangler dev --config wrangler.compose.jsonc --port 8788 --ip 0.0.0.0 --local-upstream localhost:8788
