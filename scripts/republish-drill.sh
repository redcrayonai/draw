#!/usr/bin/env bash
# The republish drill (spec §12 Robustness): create_node and get_board at
# 2 calls a second while the module publishes. Pass: every reply is a
# success, an UNAVAILABLE text or an UNCONFIRMED text, and the first success
# comes at most 10 s after the publish completes. (The canvas half — the
# offline banner, then live again within 10 s with no refresh — is watched
# by hand in an open tab.)
#
#   MCP_URL=https://mcp-staging.<domain>/mcp TOKEN=<e2e api key> \
#     PUBLISH='nix develop -c sh -c "cd module && spacetime publish … redcrayon-staging"' \
#     scripts/republish-drill.sh
#   MCP_URL=http://localhost:8788/mcp PUBLISH='…local publish…' scripts/republish-drill.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
: "${MCP_URL:?set MCP_URL}"
: "${PUBLISH:?set PUBLISH to the publish command}"
log="$(mktemp)"

MCP_URL="$MCP_URL" TOKEN="${TOKEN:-}" LOG="$log" node --input-type=module -e "
  import { connect, prefix } from '$root/mcp/scripts/mcp-call.mjs';
  import { appendFileSync } from 'node:fs';
  const { call } = await connect(process.env.MCP_URL, process.env.TOKEN || undefined);
  const start = await call('start_session', { name: 'republish-drill' });
  const board = String(JSON.parse(start.text).id);
  for (let n = 0; ; n++) {
    const r = n % 2 ? await call('get_board', { board }) : await call('create_node', { board, label: 'drill ' + n, sublabel: '', x: (n % 50) * 8, y: 0, w: 160, h: 64, token: 'ink', focal: false });
    appendFileSync(process.env.LOG, Date.now() + ' ' + prefix(r) + ' ' + r.text.slice(0, 80).replace(/\n/g, ' ') + '\n');
    await new Promise(res => setTimeout(res, 500));
  }
" &
loop=$!
trap 'kill $loop 2>/dev/null || true' EXIT
sleep 5
echo "== publishing"
eval "$PUBLISH"
done_at="$(node -e 'console.log(Date.now())')"
sleep 20
kill $loop

bad="$(grep -vE '^[0-9]+ (ok|UNAVAILABLE|UNCONFIRMED) ' "$log" || true)"
first_ok="$(awk -v t="$done_at" '$1 >= t && $2 == "ok" { print $1; exit }' "$log")"
echo "== $(wc -l <"$log") replies; log: $log"
[ -z "$bad" ] || { echo "FAIL: replies that are not ok, UNAVAILABLE or UNCONFIRMED:"; echo "$bad"; exit 1; }
[ -n "$first_ok" ] || { echo "FAIL: no success after the publish"; exit 1; }
echo "first success $(( (first_ok - done_at) / 1000 )) s after the publish completed (pass bar: 10 s)"
[ $(( first_ok - done_at )) -le 10000 ] || { echo FAIL; exit 1; }
echo PASS
