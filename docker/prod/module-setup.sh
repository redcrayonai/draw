#!/usr/bin/env bash
# compose.prod.yml's one-shot setup. It runs on every `up` and is safe to re-run:
#   1. Postgres migrations (web/db/migrations).
#   2. module/ published to SPACETIME_DB as an update, through
#      scripts/publish-module.sh: never --delete-data, and a publish that would
#      need a data reset fails instead.
#   3. The service identities: the mcp Worker's (service:mcp of its agent
#      issuer) and the dashboard's (a minted token), both in service_account.
#   4. The Demo board, public, and the board stats and slug backfills.
#   5. Generated secrets in /state, readable only by the workerd images' user:
#      agent-jwk.json (the mcp Worker's signing key) and service-token.
# The database's owner is the CLI identity in /root/.config/spacetime (a
# volume). Without it the module cannot be published again: back it up.
set -euo pipefail
. /app/docker/prod/guard.sh
. /app/docker/prod/db-issuers.sh
guard_dev_auth
guard_auth
guard_secret POSTGRES_PASSWORD
: "${DOMAIN:?set DOMAIN}" "${SPACETIME_DB:?set SPACETIME_DB}"
url="${SPACETIMEDB_URL:-http://spacetimedb:3000}"
db="$SPACETIME_DB"
mcp_origin="https://mcp.$DOMAIN"
uid=10001

st() { spacetime "$1" --no-config --server "$url" "$db" "${@:2}" 2>&1 | sed '/^WARNING:/d; /^$/d'; }
# rows <query>: the result rows as one JSON array, e.g. [[1,"Demo"]]; an error stops the setup
rows() {
  local out
  out="$(st sql --format json "$1")" || exit 1
  node -e 'console.log(JSON.stringify(JSON.parse(process.argv[1])[0].rows))' "$out"
}
# has <query>: whether the query returns a row
has() {
  local found
  found="$(rows "$1")" || exit 1
  [ "$found" != "[]" ]
}
# keep <file>: stdin to /state/<file>, for the workerd user only
keep() { install -m 0400 -o "$uid" -g "$uid" /dev/stdin "/state/$1"; }

echo "== Postgres migrations"
DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@${POSTGRES_HOST:-postgres}:5432/redcrayon?sslmode=disable" \
  dbmate --wait --no-dump-schema --migrations-dir /app/web/db/migrations up

echo "== module -> $db on $url"
browser=''
[ "${VITE_AUTH_PROVIDER:-anonymous}" != oidc ] || browser="$VITE_OIDC_ISSUER"
db_issuers="$(db_issuers "$url" /root/.config/spacetime/cli.toml)"
DB_ISSUERS="$db_issuers" MCP_ORIGIN="$mcp_origin" BROWSER_ISSUER="$browser" BROWSER_CLIENT_IDS="${VITE_OIDC_CLIENT_ID:-}" \
  APP_ORIGINS="https://$DOMAIN,https://dash.$DOMAIN" \
  SPACETIME_SERVER="$url" SPACETIME_DB="$db" PUBLISH_YES_FLAGS=remote,skip-login,break-clients,migrate \
  node /app/scripts/module-env.mjs production -- /app/scripts/publish-module.sh

echo "== service identities"
mcp="$(cd /app/shared && node --input-type=module -e "import { identityFromClaims } from './identity.ts'; console.log(identityFromClaims(process.argv[1], 'service:mcp'))" "$mcp_origin/agent-id")"
has "SELECT identity FROM service_account WHERE identity = 0x$mcp" ||
  st sql "INSERT INTO service_account (identity, label) VALUES (0x$mcp, 'mcp')" >/dev/null
token="$(cat /state/service-token 2>/dev/null || true)" hex=''
if [ -n "$token" ]; then
  hex="$(node -e 'try { console.log(JSON.parse(Buffer.from(process.argv[1].split(".")[1], "base64url")).hex_identity ?? "") } catch { console.log("") }' "$token")"
fi
if [ -z "$hex" ] || ! curl -sf -o /dev/null -H "Authorization: Bearer $token" "$url/v1/identity/$hex/verify"; then
  minted="$(curl -sf -X POST "$url/v1/identity")"
  token="$(node -e 'console.log(JSON.parse(process.argv[1]).token)' "$minted")"
  hex="$(node -e 'console.log(JSON.parse(process.argv[1]).identity)' "$minted")"
  rm -f /state/service-token
  printf '%s' "$token" | keep service-token
fi
has "SELECT identity FROM service_account WHERE identity = 0x$hex" ||
  st sql "INSERT INTO service_account (identity, label) VALUES (0x$hex, 'web')" >/dev/null

echo "== Demo board"
curl -sS --fail-with-body -o /dev/null -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '[]' "$url/v1/database/$db/call/migrate_legacy_workspaces"
# seed_demo_board is service only: the dashboard's service identity seeds it (and owns Demo).
curl -sS --fail-with-body -o /dev/null -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '[]' "$url/v1/database/$db/call/seed_demo_board"
demos="$(rows "SELECT id FROM board WHERE name = 'Demo'")"
demo="$(node -e 'const r = JSON.parse(process.argv[1]); if (r.length) console.log(String(r.map(x => BigInt(x[0])).reduce((a, b) => (a < b ? a : b))))' "$demos")"
[ -n "$demo" ] || { echo "module-setup: seed_demo_board ran but there is no board named Demo." >&2; exit 1; }
has "SELECT board_id FROM public_board WHERE board_id = $demo" ||
  st sql "INSERT INTO public_board (board_id) VALUES ($demo)" >/dev/null
curl -sS --fail-with-body -o /dev/null -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '[]' "$url/v1/database/$db/call/backfill_board_stats"
# Boards made before slugs get one, so every link is #b=<slug> (idempotent).
curl -sS --fail-with-body -o /dev/null -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '[]' "$url/v1/database/$db/call/backfill_board_slugs"

if [ ! -s /state/agent-jwk.json ]; then
  echo "== agent signing key"
  node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']).then(p=>crypto.subtle.exportKey('jwk',p.privateKey)).then(j=>console.log(JSON.stringify({...j,kid:'self-'+Date.now()})))" | keep agent-jwk.json
fi
echo "module-setup: done. canvas https://$DOMAIN · dashboard https://dash.$DOMAIN · mcp $mcp_origin/mcp"
