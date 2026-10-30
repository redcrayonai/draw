#!/usr/bin/env bash
# Links between the canvas and dashboard set ?db= only through setDb
# (shared/db-target.ts), which leaves the default database out of every URL
# people copy and share. Allowed elsewhere: setDb itself, the dashboard's own
# API request (never shown), and appHref (drops the dashboard's own default).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

if git grep -nE "\.(set|append)\([[:space:]]*['\"]db['\"]|[?&]db=\\\$\{" -- '*.ts' '*.svelte' '*.js' '*.mjs' \
  ':!*.test.ts' ':!*.test.mjs' ':!**/module_bindings/**' ':!shared/db-target.ts' ':!web/src/lib/api.ts' |
  grep -v '^web/src/lib/boards.ts:.*VITE_SPACETIME_DB'; then
  echo "::error::set ?db= with setDb (shared/db-target.ts), so links leave the default database out."
  exit 1
fi
echo "db link grep: clean"
