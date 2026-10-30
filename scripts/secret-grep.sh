#!/usr/bin/env bash
# The secret grep next to gitleaks (spec §12 Secret hygiene): API secret
# keys, and private JWK material (an EC JWK with its "d"), in tracked files.
# git grep reads only what is committed, so node_modules, mcp/.dev.vars and
# the keys tests generate at run time are never scanned.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

found=0
if git grep -nE 'sk_(live|test)_[A-Za-z0-9]{16,}'; then
  echo "::error::an API secret key is committed; revoke it with its issuer and remove it."
  found=1
fi
for f in $(git grep -lE '"kty"[[:space:]]*:[[:space:]]*"EC"'); do
  if grep -qE '"d"[[:space:]]*:[[:space:]]*"[A-Za-z0-9_-]{40,}"' "$f"; then
    echo "$f"
    echo "::error::$f holds a private EC JWK (\"d\"); rotate the key (docs: agent key rotation) and remove it."
    found=1
  fi
done
[ "$found" -eq 0 ] && echo "secret grep: clean"
exit "$found"
