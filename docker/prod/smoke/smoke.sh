#!/usr/bin/env bash
# compose.prod.yml end to end with a throwaway .env and Caddy's local CA. From
# the repo root, after `docker buildx bake -f docker/prod/docker-bake.hcl --load`:
#
#   docker/prod/smoke/smoke.sh            (TAG=<image tag>, default dev)
#
#   1. Refusals: no secrets, DEV_AUTH=1, anonymous + VITE_REQUIRE_AUTH=1, an example secret.
#   2. up: the canvas, dashboard and mcp over TLS; the realtime routes reach the
#      database and its other HTTP routes do not; mcp's database check is ok
#      (the database fetched the mcp Worker's keys through Caddy).
#   3. An agent (an MCP_API_KEYS key) draws a node; activity drains into Postgres.
#   4. down, up: the board, the activity and a Durable Object capture remain.
# The stack is removed (down -v) on exit. SMOKE_LOGS=<file> keeps its logs.
set -euo pipefail
cd "$(dirname "$0")/../../.."
tag="${TAG:-dev}"
domain=smoke.localhost
project=rc-smoke
key="$(openssl rand -hex 32)"
work="$(mktemp -d)"
cat >"$work/.env" <<EOF
DOMAIN=$domain
REDCRAYON_VERSION=$tag
VITE_AUTH_PROVIDER=anonymous
MCP_API_KEYS=$(printf %s "$key" | sha256sum | cut -d' ' -f1):smoke-user
POSTGRES_PASSWORD=$(openssl rand -hex 32)
IMPORT_RUNNER_SECRET=$(openssl rand -hex 32)
CADDY_GLOBAL_OPTIONS=local_certs
EOF
dc() { docker compose -p "$project" --env-file "$work/.env" -f compose.prod.yml -f docker/prod/smoke/compose.smoke.yml "$@"; }
cleanup() {
  [ -z "${SMOKE_LOGS:-}" ] || dc logs --no-color >"$SMOKE_LOGS" 2>&1 || true
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
# retry <seconds> <command...>: until the command succeeds
retry() {
  local until=$((SECONDS + $1))
  shift
  until "$@" >/dev/null 2>&1; do [ "$SECONDS" -lt "$until" ] || return 1; sleep 2; done
}

echo "== refusals"
grep -v '^POSTGRES_PASSWORD=' "$work/.env" >"$work/nosecret.env"
if docker compose --env-file "$work/nosecret.env" -f compose.prod.yml config >/dev/null 2>&1; then fail "compose accepted an .env without POSTGRES_PASSWORD"; fi
echo "ok: compose refuses an .env without POSTGRES_PASSWORD"
# refuses <service> <VAR=value>: the service's entrypoint exits with "refusing to start"
refuses() {
  local out
  if out="$(dc run --rm --no-deps -e "$2" "$1" 2>&1)"; then fail "$1 started with $2"; fi
  grep -q 'refusing to start' <<<"$out" || fail "$1 with $2 failed for another reason: $out"
  echo "ok: $1 refuses $2"
}
refuses mcp DEV_AUTH=1
refuses canvas VITE_REQUIRE_AUTH=1
refuses dashboard POSTGRES_PASSWORD=change-me-change-me-change-me
refuses module-setup DEV_AUTH=1

echo "== up"
dc up -d --wait --quiet-pull
retry 60 dc cp caddy:/data/caddy/pki/authorities/local/root.crt "$work/ca.crt" || fail "Caddy made no local CA"
get() { curl -sS --cacert "$work/ca.crt" --resolve "$1:443:127.0.0.1" -o /dev/null -w '%{http_code}' "${@:3}" "https://$1$2"; }
canvas_up() { [ "$(get "$domain" /)" = 200 ]; }
retry 60 canvas_up || fail "canvas: $(get "$domain" /)"
[ "$(get "dash.$domain" /dashboard)" = 200 ] || fail "dashboard: $(get "dash.$domain" /dashboard)"
[ "$(get "$domain" /v1/database/redcrayon/subscribe)" = 426 ] || fail "the realtime socket does not reach the database"
[ "$(get "$domain" /v1/database/redcrayon/sql -X POST -d 'SELECT 1')" = 405 ] || fail "the database's SQL route is reachable from outside"
health() { curl -sS --cacert "$work/ca.crt" --resolve "mcp.$domain:443:127.0.0.1" "https://mcp.$domain/health"; }
healthy() { health | grep -q '"db":"ok"'; }
retry 120 healthy || fail "mcp health: $(health)"
echo "ok: TLS canvas, dashboard, realtime routes, mcp health $(health)"

# agent.mjs inside the stack's network, where mcp.$domain reaches Caddy; the CA goes in on stdin
agent() {
  docker run --rm -i --network "${project}_default" -v "$PWD/docker/prod/smoke:/smoke:ro" \
    --entrypoint sh "ghcr.io/redcrayonai/redcrayon-module-setup:$tag" \
    -c 'cat >/tmp/ca.crt && NODE_EXTRA_CA_CERTS=/tmp/ca.crt exec node /smoke/agent.mjs "$@"' _ "$1" "https://mcp.$domain" "$key" "${@:2}" <"$work/ca.crt"
}
field() { node -p "JSON.parse(process.argv[1]).$2" "$1"; }
activity() { dc exec -T postgres psql -U postgres -d redcrayon -tAc 'SELECT count(*) FROM activity_event'; }

echo "== agent"
drawn="$(agent draw)"
[ "$(field "$drawn" nodes)" -ge 1 ] || fail "the agent's node is not on the board: $drawn"
dc exec -T drain sh -c 'curl -fsS -X POST -H "authorization: Bearer $(cat /state/service-token)" http://dashboard:5174/api/activity/drain' >/dev/null
before="$(activity)"
[ "$before" -ge 1 ] || fail "no activity drained into Postgres"
echo "ok: agent drew on board $(field "$drawn" board); $before activity row(s)"

echo "== down, up"
dc down
dc up -d --wait --quiet-pull
retry 120 healthy || fail "mcp health after restart: $(health)"
checked="$(agent check "$(field "$drawn" capture)")"
[ "$(field "$checked" board)" = "$(field "$drawn" board)" ] && [ "$(field "$checked" nodes)" -ge 1 ] || fail "the board did not survive: $drawn -> $checked"
[ "$(field "$checked" claim)" = stored ] || fail "the Durable Object capture did not survive: $checked"
[ "$(activity)" = "$before" ] || fail "activity rows changed across the restart: $before -> $(activity)"
echo "ok: board, activity and capture survived down/up"
echo "smoke: passed"
