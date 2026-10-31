#!/usr/bin/env bash
# One command for the hosted-MCP stack on this machine (spec §9 Local dev):
#   1. the local DB on :3000, started if it is not answering;
#   2. module/ published to $SPACETIME_DB (issuer variant `local`), never
#      with --delete-data;
#   3. the Demo board seeded and public, and the Worker's service:mcp identity
#      seeded into service_account (it serves /health);
#   4. mcp/.dev.vars written if missing: a fresh ES256 key, the local DB, DEV_AUTH=1;
#   5. the mcp Worker (wrangler dev, :8788; 8787 is Cursor's OAuth callback)
#      and the canvas (Vite, :5173), until Ctrl-C.
# The dashboard stays on scripts/dev-dashboard.sh.
#
#   nix develop -c scripts/dev.sh
#
# Knobs: SPACETIME_URL (http://localhost:3000), CANVAS_PORT (5173), SPACETIME_DB (redcrayon-mcp-dev;
# never `redcrayon`, which sibling worktrees share).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
url="${SPACETIME_URL:-http://localhost:3000}"
url="${url%/}"
db="${SPACETIME_DB:-redcrayon-mcp-dev}"
mcp_origin="http://localhost:8788"
canvas="http://localhost:${CANVAS_PORT:-5173}"

die() { echo "dev: $*" >&2; exit 1; }
up() { curl -sf "$url/v1/ping" >/dev/null 2>&1; }
st() { spacetime "$1" --no-config --server "$url" "$db" "${@:2}" 2>&1 | sed '/^WARNING:/d; /^$/d'; }
install() { pnpm --dir "$root/$1" install --frozen-lockfile --silent >/dev/null || die "pnpm install failed in $1/"; }

[ "$db" != redcrayon ] || die "refusing to publish to 'redcrayon': sibling worktrees share it. Set SPACETIME_DB to another name."
echo "redcrayon dev: canvas $canvas · mcp $mcp_origin/mcp"

if ! up; then
  echo "== starting the local DB on $url"
  spacetime start --listen-addr "${url#http://}" --non-interactive >/tmp/redcrayon-dev-db.log 2>&1 &
  for _ in $(seq 1 100); do up && break; sleep 0.1; done
  up || die "the DB did not start; see /tmp/redcrayon-dev-db.log"
fi

echo "== module -> $db"
for p in module mcp client shared agent; do install "$p"; done
# module-env writes the local issuers for the publish, then restores the committed (fail-closed) file.
(cd "$root/module" && MCP_ORIGIN="$mcp_origin" node "$root/scripts/module-env.mjs" local -- spacetime publish --no-config --server "$url" --yes=skip-login,break-clients,migrate "$db") >/dev/null ||
  die "publish failed. If the change needs a data reset, delete the dev database with 'spacetime delete --server $url $db' and re-run."

echo "== Demo and the service identity"
# seed_demo_board and backfill_board_slugs are service only: a minted identity runs them as one (and owns Demo), then loses the role.
seeder="$(curl -sf -X POST "$url/v1/identity")" || die "could not mint an identity at $url/v1/identity"
seeder_hex="$(node -e 'console.log(JSON.parse(process.argv[1]).identity)' "$seeder")"
st sql "INSERT INTO service_account (identity, label) VALUES (0x$seeder_hex, 'demo-seed')" >/dev/null
curl -sS --fail-with-body -o /dev/null -X POST -H "Authorization: Bearer $(node -e 'console.log(JSON.parse(process.argv[1]).token)' "$seeder")" \
  -H 'Content-Type: application/json' -d '[]' "$url/v1/database/$db/call/seed_demo_board" || die "seed_demo_board failed (above)."
# Boards made before slugs get one, so every link is #b=<slug> (service only, idempotent).
curl -sS --fail-with-body -o /dev/null -X POST -H "Authorization: Bearer $(node -e 'console.log(JSON.parse(process.argv[1]).token)' "$seeder")" \
  -H 'Content-Type: application/json' -d '[]' "$url/v1/database/$db/call/backfill_board_slugs" || die "backfill_board_slugs failed (above)."
st sql "DELETE FROM service_account WHERE identity = 0x$seeder_hex" >/dev/null
demo="$(st sql --format json "SELECT id FROM board WHERE name = 'Demo'" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"))[0].rows; console.log(r.length ? String(r.map(x=>BigInt(x[0])).reduce((a,b)=>a<b?a:b)) : "")')"
[ -n "$demo" ] || die "seed_demo_board ran but there is no board named Demo."
[ "$(st sql --format json "SELECT board_id FROM public_board WHERE board_id = $demo" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8"))[0].rows.length)')" != 0 ] ||
  st sql "INSERT INTO public_board (board_id) VALUES ($demo)" >/dev/null
# service:mcp under our dev issuer: the identity is blake3(iss|sub), so no token is needed to know it
service="$(cd "$root/shared" && node --input-type=module -e "
  import { identityFromClaims } from './identity.ts';
  console.log(identityFromClaims('$mcp_origin/agent-id', 'service:mcp'));
")"
[ "$(st sql --format json "SELECT identity FROM service_account WHERE identity = 0x$service" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8"))[0].rows.length)')" != 0 ] ||
  st sql "INSERT INTO service_account (identity, label) VALUES (0x$service, 'mcp')" >/dev/null

vars="$root/mcp/.dev.vars"
if [ ! -f "$vars" ]; then
  echo "== writing mcp/.dev.vars"
  jwk="$(node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']).then(p=>crypto.subtle.exportKey('jwk',p.privateKey)).then(j=>console.log(JSON.stringify({...j,kid:'dev-'+Date.now()})))")"
  umask 077
  printf 'DB_URL=%s\nDB_NAME=%s\nDEV_AUTH=1\nAGENT_JWK=%s\n' "$url" "$db" "$jwk" >"$vars"
fi

echo "== mcp on $mcp_origin, canvas on $canvas (Ctrl-C stops both)"
trap 'kill 0' EXIT
(cd "$root/mcp" && pnpm exec wrangler dev --port 8788 --ip 127.0.0.1 --var "DB_NAME:$db" >/tmp/redcrayon-dev-mcp.log 2>&1) &
(cd "$root/client" && VITE_SPACETIME_URI="${url/#http/ws}" VITE_SPACETIME_DB="$db" VITE_MCP_URL="$mcp_origin/mcp" pnpm exec vite --port "${CANVAS_PORT:-5173}" --strictPort) &
for _ in $(seq 1 300); do curl -sf "$mcp_origin/health" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "$mcp_origin/health" || echo "dev: mcp is not answering yet; see /tmp/redcrayon-dev-mcp.log" >&2
echo
wait
