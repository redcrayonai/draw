#!/usr/bin/env bash
# compose.prod.yml with the builder's test plugin (scripts/fixtures/outside-plugin),
# built from a git repository as a plugin outside this repo. From the repo root:
#
#   docker/prod/smoke/outside.sh
#
#   1. builder lock, then the images with a canary build secret: no layer holds it.
#   2. up: the plugin route answers 503 without its settings, 200 with plugins.env;
#      the canvas bundle carries the plugin's canvas part and, from plugins.env, its canvas setting.
#   3. upgrade to v1.1.0 (a new column): the row written before stays.
#   4. retire: the route is gone, the row stays.
#   5. roll back to the v1.1.0 images, then to the v1.0.0 ones (older than the
#      column): module-setup keeps the live module, the stack starts, the row stays.
# The stack is removed (down -v) on exit. SMOKE_LOGS=<file> keeps its logs.
set -euo pipefail
cd "$(dirname "$0")/../../.."
domain=smoke.localhost
project=rc-outside
version="${DRAW_VERSION:-$(git describe --tags --abbrev=0 --match 'v[0-9]*' | sed 's/^v//')}"
# The smoke owns plugins.env while it runs and deletes it after; never someone's real one.
[ ! -e plugins.env ] || { echo "outside.sh: move plugins.env out of the repo root first" >&2; exit 1; }
work="$(mktemp -d)"
deploy="$work/deploy"
canary="canary-$(openssl rand -hex 16)"
cat >"$work/.env" <<EOF
DOMAIN=$domain
REDCRAYON_VERSION=outside-1
VITE_AUTH_PROVIDER=anonymous
POSTGRES_PASSWORD=$(openssl rand -hex 32)
IMPORT_RUNNER_SECRET=$(openssl rand -hex 32)
CADDY_GLOBAL_OPTIONS=local_certs
EOF
dc() { docker compose -p "$project" --env-file "$work/.env" -f compose.prod.yml -f docker/prod/smoke/compose.smoke.yml "$@"; }
cleanup() {
  [ -z "${SMOKE_LOGS:-}" ] || dc logs --no-color >"$SMOKE_LOGS" 2>&1 || true
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work" plugins.env
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
retry() {
  local until=$((SECONDS + $1))
  shift
  until "$@" >/dev/null 2>&1; do [ "$SECONDS" -lt "$until" ] || return 1; sleep 2; done
}

echo "== builder image (draw $version) and the plugin repository"
DRAW_VERSION="$version" docker buildx bake -f docker/prod/docker-bake.hcl builder --load
mkdir -p "$deploy/repos"
node --input-type=module -e "import('./scripts/fixtures/outside-plugin/versions.mjs').then(m => m.makeRepo(process.argv[1], '^$version'))" "$work/src"
git clone -q --bare "$work/src" "$deploy/repos/pinboard.git"
printf 'https://smoke:%s@example.invalid\n' "$canary" >"$work/git-credentials"
plugins() { printf '{ "plugins": { "pinboard": %s } }\n' "$1" >"$deploy/draw-plugins.json"; }
builder() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$deploy:/config" "ghcr.io/redcrayonai/draw-builder:dev" "$@"; }
images() {
  builder lock --config /config --cache /tmp/cache
  TAG="$1" DRAW_VERSION="$version" docker buildx bake -f docker/prod/docker-bake.hcl --load --allow "fs.read=$work" \
    --set "*.contexts.deploy=$deploy" --set "*.secrets=id=git_credentials,src=$work/git-credentials"
}
use() { sed -i "s/^REDCRAYON_VERSION=.*/REDCRAYON_VERSION=$1/" "$work/.env"; dc up -d --wait --quiet-pull; }

plugins '{ "repo": "file:///config/repos/pinboard.git", "ref": "v1.0.0" }'
images outside-1
CANARY="$canary" docker/prod/scan-images.sh outside-1
grep -q '"pinboard"' "$deploy/draw-plugins.lock.json" || fail "the lock has no pinboard entry"
echo "ok: locked, built, no image holds the build secret"

echo "== up"
dc up -d --wait --quiet-pull
retry 60 dc cp caddy:/data/caddy/pki/authorities/local/root.crt "$work/ca.crt" || fail "Caddy made no local CA"
route() { curl -sS --cacert "$work/ca.crt" --resolve "dash.$domain:443:127.0.0.1" -o "$work/body" -w '%{http_code}' "https://dash.$domain/api/plugins/pinboard"; }
answers() { [ "$(route)" = "$1" ]; }
retry 60 answers 503 || fail "without its setting the plugin route answered $(route), not 503"
# Every script the canvas page loads, concatenated.
canvas_js() {
  local page asset
  page="$(curl -sS --cacert "$work/ca.crt" --resolve "$domain:443:127.0.0.1" "https://$domain/")"
  for asset in $(printf '%s' "$page" | grep -o '/assets/[^"]*\.js'); do
    curl -sS --cacert "$work/ca.crt" --resolve "$domain:443:127.0.0.1" "https://$domain$asset"
  done
}
canvas_js | grep -q 'pinboard-banner' || fail "the canvas bundle has no pinboard canvas part"
printf 'PINBOARD_GREETING=hello-from-plugins-env\nPINBOARD_BANNER=banner-from-plugins-env\n' >plugins.env
dc up -d --wait dashboard canvas
retry 60 answers 200 || fail "with plugins.env the plugin route answered $(route)"
grep -q hello-from-plugins-env "$work/body" || fail "the setting did not reach the plugin: $(cat "$work/body")"
banner() { canvas_js | grep -q banner-from-plugins-env; }
retry 60 banner || fail "the canvas setting from plugins.env is not in the canvas bundle"
echo "ok: plugins.env reaches the plugin and its canvas part; it is offered only with its settings"

sql() { dc run --rm --no-deps -T --entrypoint spacetime module-setup sql --server http://spacetimedb:3000 redcrayon "$1"; }
sql "INSERT INTO pinboard_note (id, workspace_id, board_id, text) VALUES (0, 1, 2, 'kept')" >/dev/null
kept() { sql "SELECT text FROM pinboard_note" | grep -q kept; }
kept || fail "the row was not written"

echo "== upgrade to v1.1.0"
plugins '{ "repo": "file:///config/repos/pinboard.git", "ref": "v1.1.0" }'
images outside-2
use outside-2
kept || fail "the row did not survive the upgrade"
sql "SELECT pinned FROM pinboard_note" | grep -q false || fail "the upgrade's column is missing"
echo "ok: upgraded; the row stays and has the new column"

echo "== retire"
plugins '{ "retired": true }'
images outside-3
use outside-3
kept || fail "the row did not survive retirement"
retry 60 answers 404 || fail "the retired plugin's route answered $(route), not 404"
echo "ok: retired; the route is gone, the row stays"

echo "== roll back"
use outside-2
kept || fail "the row did not survive the rollback to v1.1.0"
retry 60 answers 200 || fail "after the rollback to v1.1.0 the route answered $(route)"
use outside-1
dc logs module-setup | grep -q 'kept the live module' || fail "module-setup did not keep the newer live module"
kept || fail "the row did not survive the rollback to v1.0.0"
retry 60 answers 200 || fail "after the rollback to v1.0.0 the route answered $(route)"
echo "ok: rolled back twice; the newer database kept its data"
echo "outside smoke: passed"
