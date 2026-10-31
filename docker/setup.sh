#!/usr/bin/env bash
# docker-compose.yml's one-shot setup. scripts/dev-dashboard.sh does the
# migrations, the module publish, the Demo board, the board backfills (stats,
# slugs) and the dashboard's service identity; this adds the mcp Worker's part of scripts/dev.sh (service:mcp in
# service_account, .dev.vars less sign-in, which docker/mcp.sh adds). Output
# goes to /state for the other containers.
# Safe to re-run, like both scripts.
set -euo pipefail

url=http://localhost:3000
db="$SPACETIME_DB"
mcp_origin=http://localhost:8788

ENV_FILE=/state/web.env PG_EXTERNAL=1 scripts/dev-dashboard.sh

st() { spacetime "$1" --no-config --server "$url" "$db" "${@:2}" 2>&1 | sed '/^WARNING:/d; /^$/d'; }
service="$(cd shared && node --input-type=module -e "
  import { identityFromClaims } from './identity.ts';
  console.log(identityFromClaims('$mcp_origin/agent-id', 'service:mcp'));
")"
[ "$(st sql --format json "SELECT identity FROM service_account WHERE identity = 0x$service" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8"))[0].rows.length)')" != 0 ] ||
  st sql "INSERT INTO service_account (identity, label) VALUES (0x$service, 'mcp')" >/dev/null

vars=/state/mcp.dev.vars
if [ ! -f "$vars" ]; then
  jwk="$(node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']).then(p=>crypto.subtle.exportKey('jwk',p.privateKey)).then(j=>console.log(JSON.stringify({...j,kid:'dev-'+Date.now()})))")"
  umask 077
  printf 'DB_URL=%s\nDB_NAME=%s\nAGENT_JWK=%s\n' "$url" "$db" "$jwk" >"$vars"
fi
echo "setup: done. canvas http://localhost:5173 · dashboard http://localhost:5174 · mcp $mcp_origin/mcp"
