#!/usr/bin/env bash
# Isolated SpacetimeDB for the module integration tests (RC-530). It has its
# own root dir (JWT keys, cli.toml, data) and port, so it never touches the
# shared server on :3000 or the 'redcrayon' database sibling sessions use.
# Run inside the nix dev shell from the repo root:
#
#   scripts/stdb-test.sh run [node --test args]   start, publish module/ fresh,
#                                                  legacy checks, suite, stop
#   scripts/stdb-test.sh start|publish|legacy|stop
#   scripts/stdb-test.sh test [node --test args]
#   scripts/stdb-test.sh parity                    start, publish fresh, check the
#                                                  hosted path against the frozen
#                                                  agent/src/parity.golden.json (local
#                                                  git, then helper captures), stop
#   scripts/stdb-test.sh mcp                       start, publish fresh, run the mcp
#                                                  Worker's tools against it, stop
#   scripts/stdb-test.sh versions                  start, publish fresh, run the dashboard's
#                                                  Versions code against it and the store in
#                                                  VERSIONS_S3_*, stop
#   scripts/stdb-test.sh failclosed                start, publish the committed
#                                                  `none` issuers, check that it
#                                                  refuses every sender, stop
#
# MODULE_ENV (default local; local|staging|production) picks the issuers
# variant `publish` writes (scripts/module-env.mjs). The test issuers are served
# by scripts/verify-issuers-local.mjs on STDB_TEST_ISSUER_PORT (default PORT+1),
# so the published module names them whatever the variant. Their signing key
# lives in the root dir, beside the owner token.
#
# The owner token is minted on this server (POST /v1/identity) and saved in
# the isolated cli.toml, so `publish` makes it the database owner: the only
# identity allowed SQL DML (seeding service_account, test fixtures).
set -euo pipefail

ROOT="${STDB_TEST_ROOT:-${TMPDIR:-/tmp}/redcrayon-stdb-test}"
PORT="${STDB_TEST_PORT:-3100}"
URL="http://127.0.0.1:$PORT"
DB="${STDB_TEST_DB:-redcrayon-test}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ISSUER_PORT="${STDB_TEST_ISSUER_PORT:-$((PORT + 1))}"
export MODULE_ENV="${MODULE_ENV:-local}"
export MCP_ORIGIN="http://127.0.0.1:$ISSUER_PORT"
# The browser issuer, with the session claim the hosted service sets.
export BROWSER_ISSUER="http://127.0.0.1:$ISSUER_PORT/browser"
export BROWSER_SESSION_CLAIM=sid
export OIDC_ISSUER="$BROWSER_ISSUER" # the mcp Worker's name for the browser issuer
export APP_ORIGINS="http://localhost:5173"
# An OIDC client id (RC-609); BROWSER_CLIENT_IDS= runs the hosted service's rule, which has none.
export BROWSER_CLIENT_IDS="${BROWSER_CLIENT_IDS-redcrayon}"
export STDB_TEST_ISSUER_KEY="$ROOT/issuer-key.pem"

if [ "$DB" = redcrayon ]; then
  echo "refusing to use the shared 'redcrayon' database; set STDB_TEST_DB to another name" >&2
  exit 1
fi

st() { spacetime --root-dir "$ROOT" "$@"; }
up() { curl -sf "$URL/v1/ping" >/dev/null 2>&1; }

start() {
  mkdir -p "$ROOT"
  if up && [ ! -s "$ROOT/server.pid" ]; then
    echo "another server already listens on $URL; set STDB_TEST_PORT to a free port" >&2
    exit 1
  fi
  if ! up; then
    spacetime --root-dir "$ROOT" start --listen-addr "127.0.0.1:$PORT" --non-interactive >"$ROOT/server.log" 2>&1 &
    echo $! >"$ROOT/server.pid"
    for _ in $(seq 1 100); do up && break; sleep 0.1; done
    up || { cat "$ROOT/server.log" >&2; echo "SpacetimeDB did not start on $URL" >&2; exit 1; }
  fi
  if [ ! -s "$ROOT/owner-token" ]; then
    curl -sf -X POST "$URL/v1/identity" \
      | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).token)' >"$ROOT/owner-token"
    st login --token "$(cat "$ROOT/owner-token")" >/dev/null
  fi
}

stop() {
  if [ -s "$ROOT/server.pid" ]; then
    pid="$(cat "$ROOT/server.pid")"
    kill "$pid" 2>/dev/null || true
    # Wait for it to go: a start right after (parity, then mcp) needs the port.
    for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    rm -f "$ROOT/server.pid"
  fi
}

# module-env writes the MODULE_ENV issuers, publishes, and restores the committed `none` file.
publish() {
  [ -d "$REPO/module/node_modules" ] || pnpm --dir "$REPO/module" install --frozen-lockfile
  (cd "$REPO/module" && node "$REPO/scripts/module-env.mjs" "$MODULE_ENV" -- \
    spacetime --root-dir "$ROOT" publish --no-config --server "$URL" --yes --delete-data=always "$DB")
}

legacy() {
  SPACETIME_ROOT_DIR="$ROOT" SPACETIME_SERVER="$URL" SPACETIME_DB="$DB" "$REPO/scripts/verify-module-local.sh"
}

suite() {
  # verify-access-local.mjs forks a board through importer/src/fork-board.ts.
  [ -d "$REPO/importer/node_modules" ] || pnpm --dir "$REPO/importer" install --frozen-lockfile
  # First and alone: its timing case needs a database no other suite has used yet.
  STDB_URL="$URL" STDB_DB="$DB" STDB_OWNER_TOKEN="$(cat "$ROOT/owner-token")" \
    node --test "$REPO/scripts/verify-board-scope-local.mjs"
  STDB_URL="$URL" STDB_DB="$DB" STDB_OWNER_TOKEN="$(cat "$ROOT/owner-token")" \
    node --test "$@" "$REPO/scripts/verify-dashboard-local.mjs" "$REPO/scripts/verify-access-local.mjs" "$REPO/scripts/verify-issuers-local.mjs" \
      "$REPO/scripts/verify-change-notes-local.mjs" "$REPO/scripts/verify-threats-local.mjs" "$REPO/scripts/verify-icons-local.mjs" \
      "$REPO/scripts/verify-code-consent-local.mjs" "$REPO/scripts/verify-deletion-local.mjs"
  # After, and alone: it serves the test issuer on the port verify-issuers-local.mjs serves it on.
  STDB_URL="$URL" STDB_DB="$DB" STDB_OWNER_TOKEN="$(cat "$ROOT/owner-token")" \
    node --test "$REPO/scripts/verify-marks-local.mjs"
  # Workspace auth uses the same saved issuer key and port; run after both issuer servers exit.
  STDB_URL="$URL" STDB_DB="$DB" STDB_OWNER_TOKEN="$(cat "$ROOT/owner-token")" \
    node --test "$REPO/scripts/verify-workspaces-local.mjs"
  STDB_URL="$URL" STDB_DB="$DB" STDB_OWNER_TOKEN="$(cat "$ROOT/owner-token")" \
    node --test "$REPO/scripts/verify-workspace-service-accounts-local.mjs"
  # Versions serves the same issuer key and port, so it runs alone too.
  STDB_URL="$URL" STDB_DB="$DB" STDB_OWNER_TOKEN="$(cat "$ROOT/owner-token")" \
    node --test "$REPO/scripts/verify-versions-local.mjs"
  # Skips itself unless the module was published with REDCRAYON_LIMITS=on.
  STDB_URL="$URL" STDB_DB="$DB" STDB_OWNER_TOKEN="$(cat "$ROOT/owner-token")" \
    node --test "$REPO/scripts/verify-limits-local.mjs"
  # Last and alone: it resets Demo, which the suites above read.
  STDB_URL="$URL" STDB_DB="$DB" STDB_OWNER_TOKEN="$(cat "$ROOT/owner-token")" \
    node --test "$REPO/scripts/verify-demo-reset-local.mjs"
}

# The same fixture through the HTTP snapshot, against the golden rows (mcp/):
# on this machine's git, then on helper captures (capture-deps.ts).
parity() {
  [ -d "$REPO/mcp/node_modules" ] || pnpm --dir "$REPO/mcp" install --frozen-lockfile
  STDB_URL="$URL" STDB_DB="$DB" pnpm --dir "$REPO/mcp" run test:db
}

# The mcp Worker in-process against the DB, through MCP clients of both eras.
mcp() {
  # mcp/ imports shared/ and agent/ by path, so their packages must be installed too.
  for p in shared agent mcp helper; do [ -d "$REPO/$p/node_modules" ] || pnpm --dir "$REPO/$p" install --frozen-lockfile; done
  # The capture tests run the helper as an agent does: the built file.
  pnpm --dir "$REPO/helper" run build >/dev/null
  STDB_URL="$URL" STDB_DB="$DB" STDB_OWNER_TOKEN="$(cat "$ROOT/owner-token")" pnpm --dir "$REPO/mcp" run test:worker
}

# Versions end to end (PLUGINS.md): the dashboard server's Versions code against this database and
# the S3-compatible store the VERSIONS_S3_* variables name, e.g. a local server with an empty bucket.
versions() {
  : "${VERSIONS_S3_ENDPOINT:?set VERSIONS_S3_ENDPOINT and the other VERSIONS_S3_* variables (SELF_HOSTING.md) to a local store}"
  [ -d "$REPO/web/node_modules" ] || pnpm --dir "$REPO/web" install --frozen-lockfile
  VERSIONS_E2E=1 STDB_URL="$URL" STDB_DB="$DB" STDB_OWNER_TOKEN="$(cat "$ROOT/owner-token")" \
    pnpm --dir "$REPO/web" exec vitest run src/lib/server/versions.e2e.test.ts
}

cmd="${1:-}"
shift || true
case "$cmd" in
  start) start ;;
  stop) stop ;;
  publish) publish ;;
  legacy) legacy ;;
  test) suite "$@" ;;
  run)
    trap stop EXIT
    start
    publish
    legacy
    suite "$@"
    ;;
  parity|mcp|versions)
    trap stop EXIT
    start
    publish
    "$cmd"
    ;;
  failclosed)
    # Nothing but a service account can connect, the owner included, so only the issuer suite runs.
    trap stop EXIT
    start
    MODULE_ENV=none publish
    MODULE_ENV=none STDB_URL="$URL" STDB_DB="$DB" STDB_OWNER_TOKEN="$(cat "$ROOT/owner-token")" \
      node --test "$@" "$REPO/scripts/verify-issuers-local.mjs"
    ;;
  *)
    echo "usage: scripts/stdb-test.sh run|start|publish|legacy|test|parity|mcp|versions|failclosed|stop [node --test args]" >&2
    exit 2
    ;;
esac
