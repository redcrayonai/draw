#!/usr/bin/env bash
# Compare public wire shapes with origin/main, or an explicitly supplied live
# `spacetime describe --json` baseline. Every publish below is local and disposable.
set -euo pipefail
[ "$#" -le 1 ] || { echo 'usage: scripts/check-module-upgrade.sh [baseline.json]' >&2; exit 2; }
repo="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$repo/module/node_modules" ] || { echo 'Install module dependencies first.' >&2; exit 1; }
baseline="${1:-}"
if [ -n "$baseline" ]; then
  [ -s "$baseline" ] || { echo "Missing schema baseline: $baseline" >&2; exit 1; }
  baseline="$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$baseline")"
fi
if [ -z "$baseline" ] && ! git -C "$repo" cat-file -e origin/main:module 2>/dev/null; then
  echo 'origin/main has no module/ yet (the first import): nothing to compare.'
  exit 0
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/redcrayon-wire.XXXXXX")"
export STDB_TEST_ROOT="$scratch/database"
export STDB_TEST_DB=redcrayon-wire-candidate
export STDB_TEST_PORT
cleanup() {
  local status=$?
  trap - EXIT
  bash "$repo/scripts/stdb-test.sh" stop || true
  rm -rf "$scratch"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
STDB_TEST_PORT="$(node --input-type=module <<'NODE'
import { createServer } from 'node:net';
const server = createServer();
server.listen(0, '127.0.0.1', () => {
  console.log(server.address().port);
  server.close();
});
NODE
)"

candidate="$scratch/candidate/module"
mkdir -p "$candidate"
cp -R "$repo/module/src" "$candidate/src"
cp "$repo/module/package.json" "$repo/module/pnpm-lock.yaml" "$repo/module/tsconfig.json" "$candidate/"
ln -s "$repo/module/node_modules" "$candidate/node_modules"

if [ -z "$baseline" ]; then
  mkdir -p "$scratch/baseline"
  git -C "$repo" archive origin/main module | tar -xf - -C "$scratch/baseline"
  pnpm -C "$scratch/baseline/module" install --frozen-lockfile
fi
bash "$repo/scripts/stdb-test.sh" start

describe_local() {
  local source=$1 database=$2 output=$3
  (
    cd "$source"
    spacetime --root-dir "$STDB_TEST_ROOT" publish --no-config \
      --server "http://127.0.0.1:$STDB_TEST_PORT" --yes --delete-data=always "$database"
  )
  spacetime --root-dir "$STDB_TEST_ROOT" describe --json \
    --server "http://127.0.0.1:$STDB_TEST_PORT" "$database" > "$output"
}

if [ -z "$baseline" ]; then
  baseline="$scratch/baseline.json"
  describe_local "$scratch/baseline/module" redcrayon-wire-baseline "$baseline"
fi
describe_local "$candidate" "$STDB_TEST_DB" "$scratch/candidate.json"
node "$repo/scripts/check-wire-compat.mjs" "$baseline" "$scratch/candidate.json"
