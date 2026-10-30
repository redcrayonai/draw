#!/usr/bin/env bash
# One command for the local dashboard stack (spec 2026-10-05 §5):
#   1. Postgres via scripts/pg.sh, then dbmate migrations (web/db/migrations).
#   2. module/ published to a SEPARATE database (default redcrayon-dash). Never
#      `redcrayon`: sibling worktrees share that one on the same local server.
#   3. A service identity (POST /v1/identity) seeded into service_account by
#      the database owner (you, through the CLI), the Demo board seeded and
#      marked public, then backfill_board_stats called with the service token.
#   4. web/.env.local written with every server and client variable.
# Safe to re-run: the service token is reused while the server accepts it,
# seeds are skipped when present, migrations only apply what is new.
#
#   nix develop --command scripts/dev-dashboard.sh
#   SPACETIME_URL=http://127.0.0.1:3100 SPACETIME_DB=redcrayon-e2e PG_DB=redcrayon_e2e scripts/dev-dashboard.sh
#
# Knobs (defaults): SPACETIME_URL (http://localhost:3000), SPACETIME_DB
# (redcrayon-dash), PGPORT (5432), PG_DB (redcrayon), CANVAS_URL
# (http://localhost:5173), ENV_FILE (web/.env.local), PG_EXTERNAL (unset; set =
# Postgres already runs elsewhere, skip scripts/pg.sh). Needs a running
# SpacetimeDB (`spacetime start`).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
url="${SPACETIME_URL:-http://localhost:3000}"
url="${url%/}"
db="${SPACETIME_DB:-redcrayon-dash}"
canvas="${CANVAS_URL:-http://localhost:5173}"
pg_url="postgres://postgres@localhost:${PGPORT:-5432}/${PG_DB:-redcrayon}?sslmode=disable"
env_file="${ENV_FILE:-$root/web/.env.local}"

die() { echo "dev-dashboard: $*" >&2; exit 1; }
# st <sql|call> <args…>: one CLI command against $url/$db; on failure print the CLI's error and stop
st() {
  local cmd="$1" out
  shift
  out="$(spacetime "$cmd" --no-config --server "$url" "$db" "$@" 2>&1)" || { sed '/^WARNING:/d' <<<"$out" >&2; exit 1; }
  sed '/^WARNING:/d; /^$/d' <<<"$out"
}
# rows <query>: the result rows as one JSON array, e.g. [[1,"Demo"]]
rows() {
  local out
  out="$(st sql --format json "$1")" || exit 1
  node -e 'console.log(JSON.stringify(JSON.parse(process.argv[1])[0].rows))' "$out"
}

# pnpm_install <dir>: frozen-lockfile install; pnpm writes its errors to stdout, so show them on failure
pnpm_install() {
  local out
  out="$(pnpm --dir "$root/$1" install --frozen-lockfile 2>&1)" || { echo "$out" >&2; die "pnpm install failed in $1/ (above). If the lockfile is out of date, run 'pnpm install' there and commit the lockfile."; }
}

[ "$db" != redcrayon ] || die "refusing to publish to 'redcrayon': sibling worktrees share it. Set SPACETIME_DB to another name."
curl -sf "$url/v1/ping" >/dev/null || die "SpacetimeDB is not answering at $url. Start it with 'spacetime start', or set SPACETIME_URL."

echo "== Postgres ($pg_url)"
[ -n "${PG_EXTERNAL:-}" ] || "$root/scripts/pg.sh" start >/dev/null
pnpm_install web
(cd "$root/web" && DATABASE_URL="$pg_url" pnpm exec dbmate --wait --no-dump-schema up)

echo "== module -> $db on $url"
pnpm_install module
# No `remote` in --yes: a non-local SPACETIME_URL still asks before publishing.
# module-env writes the local issuers for the publish, then restores the committed (fail-closed) file.
(cd "$root/module" && node "$root/scripts/module-env.mjs" local -- spacetime publish --no-config --server "$url" --yes=skip-login,break-clients,migrate "$db") ||
  die "publish failed (above). If the change needs a data reset, delete the dev database with 'spacetime delete --server $url $db' and re-run."

echo "== service identity"
token="" hex=""
if [ -f "$env_file" ]; then token="$(sed -n 's/^SPACETIMEDB_SERVICE_TOKEN=//p' "$env_file" | tail -n 1)"; fi
if [ -n "$token" ]; then
  hex="$(node -e 'try { console.log(JSON.parse(Buffer.from(process.argv[1].split(".")[1], "base64url")).hex_identity ?? "") } catch { console.log("") }' "$token")"
fi
if [ -n "$hex" ] && curl -sf -o /dev/null -H "Authorization: Bearer $token" "$url/v1/identity/$hex/verify"; then
  echo "reusing 0x$hex from web/.env.local"
else
  minted="$(curl -sf -X POST "$url/v1/identity")" || die "could not mint an identity at $url/v1/identity"
  token="$(node -e 'console.log(JSON.parse(process.argv[1]).token)' "$minted")"
  hex="$(node -e 'console.log(JSON.parse(process.argv[1]).identity)' "$minted")"
  echo "minted 0x$hex"
fi
seeded="$(rows "SELECT identity FROM service_account WHERE identity = 0x$hex")"
if [ "$seeded" = "[]" ]; then
  st sql "INSERT INTO service_account (identity, label) VALUES (0x$hex, 'web')" >/dev/null
fi

echo "== Demo board"
curl -sS --fail-with-body -o /dev/null -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '[]' "$url/v1/database/$db/call/migrate_legacy_workspaces" || die "migrate_legacy_workspaces failed (above)."
# seed_demo_board is service only: the service identity above seeds it (and owns Demo).
curl -sS --fail-with-body -o /dev/null -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '[]' "$url/v1/database/$db/call/seed_demo_board" || die "seed_demo_board failed (above)."
demos="$(rows "SELECT id FROM board WHERE name = 'Demo'")"
demo="$(node -e 'const r = JSON.parse(process.argv[1]); if (r.length) console.log(String(r.map(x => BigInt(x[0])).reduce((a, b) => (a < b ? a : b))))' "$demos")"
[ -n "$demo" ] || die "seed_demo_board ran but there is no board named Demo."
public="$(rows "SELECT board_id FROM public_board WHERE board_id = $demo")"
if [ "$public" = "[]" ]; then
  st sql "INSERT INTO public_board (board_id) VALUES ($demo)" >/dev/null
fi
curl -sS --fail-with-body -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '[]' "$url/v1/database/$db/call/backfill_board_stats" || die "backfill_board_stats failed (above)."
# Boards made before slugs get one, so every link is #b=<slug> (service only, idempotent).
curl -sS --fail-with-body -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '[]' "$url/v1/database/$db/call/backfill_board_slugs" || die "backfill_board_slugs failed (above)."

ws="${url/#http/ws}"
umask 077
{
  if [ -f "$env_file" ]; then sed '/^# >>> dev-dashboard.sh/,/^# <<< dev-dashboard.sh/d' "$env_file"; fi
  cat <<VARS
# >>> dev-dashboard.sh — rewritten on every run. Put authentication keys and other values outside this block.
DATABASE_URL=$pg_url
SPACETIMEDB_URL=$url
SPACETIMEDB_DB=$db
SPACETIMEDB_SERVICE_TOKEN=$token
VITE_SPACETIME_URI=$ws
VITE_SPACETIME_DB=$db
VITE_CANVAS_URL=$canvas
# <<< dev-dashboard.sh
VARS
} >"$env_file.tmp"
mv "$env_file.tmp" "$env_file"

cat <<NEXT

Ready: database $db on $url (Demo board $demo is public), Postgres $pg_url.
Wrote web/.env.local (service identity 0x$hex).

Next, in two more terminals:
  cd web && pnpm dev                                                      # dashboard  http://localhost:5174
  cd client && pnpm install --frozen-lockfile && VITE_SPACETIME_URI=$ws VITE_SPACETIME_DB=$db VITE_DASHBOARD_URL=http://localhost:5174 pnpm dev --port ${canvas##*:} --strictPort   # canvas  $canvas
Dashboard links open the canvas at #b=<slug> (both serve $db, so links leave ?db= out).
NEXT
