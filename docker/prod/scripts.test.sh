#!/bin/sh
# sh docker/prod/scripts.test.sh: startup guards, runtime config and publish rollback.
# Requires GNU or busybox sed, as in the images.
set -eu
cd "$(dirname "$0")"
fails=0
ok() { echo "ok: $1"; }
bad() { echo "FAIL: $1" >&2; fails=$((fails + 1)); }
# refuses <name> <env...> -- <guard calls>: the guards exit non-zero with these settings
refuses() {
  name=$1
  shift
  if env -i "$@" sh -c '. ./guard.sh; guard_dev_auth; guard_auth; guard_api_keys; guard_secret POSTGRES_PASSWORD' >/dev/null 2>&1; then bad "$name"; else ok "$name"; fi
}
good=POSTGRES_PASSWORD=not-a-real-password-just-long
refuses 'DEV_AUTH=1' DEV_AUTH=1 "$good"
refuses 'anonymous + VITE_REQUIRE_AUTH=1' VITE_AUTH_PROVIDER=anonymous VITE_REQUIRE_AUTH=1 "$good"
refuses 'unset provider + VITE_REQUIRE_AUTH=true' VITE_REQUIRE_AUTH=true "$good"
refuses 'oidc without an issuer' VITE_AUTH_PROVIDER=oidc VITE_OIDC_CLIENT_ID=x "$good"
refuses 'an unknown provider' VITE_AUTH_PROVIDER=custom "$good"
refuses 'an empty secret' POSTGRES_PASSWORD=
refuses 'an example secret' POSTGRES_PASSWORD=change-me-change-me-change-me
refuses 'a short secret' POSTGRES_PASSWORD=hunter2
refuses 'a secret that breaks a URL' POSTGRES_PASSWORD='0123456789abcdef@host/x'
refuses 'an example MCP_API_KEYS entry' MCP_API_KEYS='<sha256>:<user id>' "$good"
if env -i "$good" VITE_AUTH_PROVIDER=oidc VITE_OIDC_ISSUER=https://id.example.com VITE_OIDC_CLIENT_ID=redcrayon VITE_REQUIRE_AUTH=1 DEV_AUTH=0 \
  sh -c '. ./guard.sh; guard_dev_auth; guard_auth; guard_api_keys; guard_secret POSTGRES_PASSWORD'; then ok 'a good oidc config starts'; else bad 'a good oidc config starts'; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf 'const a={VITE_SPACETIME_URI:"__rc_spacetime_uri__"},b="__rc_oidc_issuer__",c="__rc_require_auth__";\n' >"$tmp/app.js"
env -i PATH="$PATH" VITE_SPACETIME_URI=wss://board.example.com VITE_OIDC_ISSUER='https://id.example.com/realms/a?b=c' VITE_REQUIRE_AUTH= \
  sh -c '. ./guard.sh; . ./runtime-config.sh; runtime_config "$1" spacetime_uri oidc_issuer require_auth' _ "$tmp"
[ "$(cat "$tmp/app.js")" = 'const a={VITE_SPACETIME_URI:"wss://board.example.com"},b="https://id.example.com/realms/a?b=c",c="";' ] &&
  ok 'runtime_config writes the values' || bad "runtime_config writes the values: $(cat "$tmp/app.js")"
if env -i PATH="$PATH" VITE_SPACETIME_URI='wss://x";alert(1);"' sh -c '. ./guard.sh; . ./runtime-config.sh; runtime_config "$1" spacetime_uri' _ "$tmp" 2>/dev/null; then
  bad 'runtime_config refuses a quote'
else ok 'runtime_config refuses a quote'; fi
for value in "https://x/'a" 'https://x/?a=1&b=2' 'https://x/a\b' 'https://x/a|b' "$(printf 'https://x/a\nb')"; do
  if env -i PATH="$PATH" VITE_SPACETIME_URI="$value" sh -c '. ./guard.sh; . ./runtime-config.sh; runtime_config "$1" spacetime_uri' _ "$tmp" 2>/dev/null; then
    bad "runtime_config refuses $value"
  else ok "runtime_config refuses $value"; fi
done

printf 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\neth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\neth1\t0008A8C0\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0\n' >"$tmp/route"
[ "$(sh -c '. ./runtime-config.sh; own_networks "$1"' _ "$tmp/route" | paste -sd, -)" = '172.17.0.0/16,192.168.8.0/20' ] &&
  ok 'own_networks reads the routing table' || bad 'own_networks reads the routing table'

extras() { env -i "$@" sh -c '. ./guard.sh; . ./runtime-config.sh; extra_networks' | paste -sd, -; }
[ "$(extras 'WORKER_NETWORKS=10.96.0.0/12, fd00:10:96::/108')" = '10.96.0.0/12,fd00:10:96::/108' ] &&
  ok 'extra_networks reads WORKER_NETWORKS' || bad 'extra_networks reads WORKER_NETWORKS'
[ -z "$(extras)" ] && ok 'extra_networks: none by default' || bad 'extra_networks: none by default'
if env -i 'WORKER_NETWORKS=10.0.0.0/8"]);' sh -c '. ./guard.sh; . ./runtime-config.sh; extra_networks' >/dev/null 2>&1; then bad 'extra_networks refuses a quote'; else ok 'extra_networks refuses a quote'; fi

roles() { env -i "$@" sh -c '. ./runtime-config.sh; role_networks' | paste -sd, -; }
storage='VERSIONS_S3_ENDPOINT=https://s3.example.com VERSIONS_S3_BUCKET=b VERSIONS_S3_REGION=r'
[ "$(roles $storage)" = '169.254.169.254/32,169.254.170.2/32' ] &&
  ok 'role_networks opens the credential endpoints for Versions without keys' || bad 'role_networks opens the credential endpoints for Versions without keys'
[ "$(roles $storage 'VERSIONS_S3_ACCESS_KEY_ID= ' 'VERSIONS_S3_SECRET_ACCESS_KEY= ')" = '169.254.169.254/32,169.254.170.2/32' ] &&
  ok 'role_networks: blank keys are no keys' || bad 'role_networks: blank keys are no keys'
[ -z "$(roles $storage VERSIONS_S3_ACCESS_KEY_ID=key VERSIONS_S3_SECRET_ACCESS_KEY=secret)" ] &&
  ok 'role_networks: none with keys' || bad 'role_networks: none with keys'
[ -z "$(roles $storage VERSIONS_S3_ACCESS_KEY_ID=key)" ] &&
  ok 'role_networks: none with only the key id (Versions is off)' || bad 'role_networks: none with only the key id (Versions is off)'
[ -z "$(roles $storage VERSIONS_S3_SECRET_ACCESS_KEY=secret)" ] &&
  ok 'role_networks: none with only the secret (Versions is off)' || bad 'role_networks: none with only the secret (Versions is off)'
[ -z "$(roles VERSIONS_S3_ENDPOINT=https://s3.example.com)" ] &&
  ok 'role_networks: none with incomplete storage (Versions is off)' || bad 'role_networks: none with incomplete storage (Versions is off)'
[ -z "$(roles)" ] && ok 'role_networks: none without Versions' || bad 'role_networks: none without Versions'

# db_issuers: a stand-in curl answers POST /v1/identity with an anonymous token of issuer `localhost`.
jwt() { printf 'x.%s.y' "$(printf '{"iss":"%s","sub":"s"}' "$1" | base64 | tr '+/' '-_' | tr -d '=\n')"; }
mkdir "$tmp/bin"
printf '#!/bin/sh\nprintf %%s %s\n' "'{\"identity\":\"ab\",\"token\":\"$(jwt localhost)\"}'" >"$tmp/bin/curl"
chmod +x "$tmp/bin/curl"
printf 'default_server = "local"\nspacetimedb_token = "%s"\n' "$(jwt https://auth.example.com)" >"$tmp/cli.toml"
issuers() { PATH="$tmp/bin:$PATH" sh -c '. ./db-issuers.sh; db_issuers http://db "$1"' _ "$1"; }
[ "$(issuers "$tmp/cli.toml")" = 'localhost,https://auth.example.com' ] &&
  ok 'db_issuers admits a saved login of another issuer' || bad "db_issuers admits a saved login of another issuer: $(issuers "$tmp/cli.toml")"
[ "$(issuers "$tmp/missing.toml")" = 'localhost' ] &&
  ok 'db_issuers on a first install: the anonymous issuer only' || bad "db_issuers on a first install: $(issuers "$tmp/missing.toml")"
printf '#!/bin/sh\nexit 7\n' >"$tmp/bin/curl"
if issuers "$tmp/cli.toml" >/dev/null 2>&1; then bad 'db_issuers fails when the database does not answer'; else ok 'db_issuers fails when the database does not answer'; fi

# Refusals captured with the pinned CLI (2.8.1), 2026-10-31.
cat >"$tmp/columns.log" <<'LOG'
Checking for breaking changes...
Errors occurred:
Removing a column added_field from table board requires a manual migration
Removing a column another_field from table board requires a manual migration
Aborting publish due to required manual migration.
Error: Aborting because publishing would require manual migration or deletion of data and --delete-data was not specified.
LOG
printf '\033[1m\033[31mRemoved\033[0m table: \033[1m\033[36mplugin_data\033[0m\nPublishing module...\n\033[31mError: Failed to create or update the database: Cannot remove table `plugin_data`: table contains data. Clear the table\047s rows (e.g. via a reducer) before removing it from your schema.\033[0m\n' >"$tmp/table.log"
sed '/ Clear the table/ s/ Clear the table.*//' "$tmp/table.log" >"$tmp/table-short.log"
sed 's/plugin_data/import_failure/' "$tmp/table.log" >"$tmp/table-word.log"
printf 'Removed table: connection failed\n' >"$tmp/plan-words.log"
cat "$tmp/table.log" >>"$tmp/plan-words.log"
sed '/Aborting publish/i\
Changing the type of column title in table board requires a manual migration
' "$tmp/columns.log" >"$tmp/mixed.log"
head -n 3 "$tmp/columns.log" >"$tmp/truncated.log"
: >"$tmp/empty.log"
printf 'Error: connection refused\n' >"$tmp/connection.log"
cat "$tmp/columns.log" >"$tmp/unknown-error.log"
printf 'Error: an unrelated failure\n' >>"$tmp/unknown-error.log"
printf 'Error: an unrelated failure\n' >"$tmp/prior-error.log"
cat "$tmp/columns.log" >>"$tmp/prior-error.log"
printf 'Connection failed\n' >"$tmp/prior-connection.log"
cat "$tmp/columns.log" >>"$tmp/prior-connection.log"
printf 'publish timed out\n' >"$tmp/prior-timeout.log"
cat "$tmp/columns.log" >>"$tmp/prior-timeout.log"
cat "$tmp/columns.log" >"$tmp/timeout.log"
printf 'publish timed out\n' >>"$tmp/timeout.log"
rollback_accepts() { sh -c '. ./rollback.sh; older_program "$1"' _ "$1"; }
for diagnostic in 'error[E0308]: mismatched types' 'FATAL: could not publish' 'publish FAILURE' "thread main panicked" 'uncaught exception'; do
  printf '%s\n' "$diagnostic" >"$tmp/diagnostic.log"
  cat "$tmp/columns.log" >>"$tmp/diagnostic.log"
  if rollback_accepts "$tmp/diagnostic.log"; then bad "rollback rejects $diagnostic"; else ok "rollback rejects $diagnostic"; fi
done
for fixture in columns table table-short table-word; do
  if rollback_accepts "$tmp/$fixture.log"; then ok "rollback accepts $fixture"; else bad "rollback accepts $fixture"; fi
done
for fixture in mixed truncated empty missing connection plan-words unknown-error prior-error prior-connection prior-timeout timeout; do
  if rollback_accepts "$tmp/$fixture.log"; then bad "rollback rejects $fixture"; else ok "rollback rejects $fixture"; fi
done

# Exercise the actual setup block with a fake module-env command, not a copy of its conditional.
awk '/^echo "== module ->/ { block = 1 } /^echo "== service identities"/ { block = 0 } block' module-setup.sh |
  sed "s|/tmp/publish.log|$tmp/publish.log|g" >"$tmp/publish-block.sh"
cat >"$tmp/bin/node" <<'SH'
#!/bin/sh
[ -z "$PUBLISH_FIXTURE" ] || cp "$PUBLISH_FIXTURE" "$PUBLISH_LOG"
exit "$PUBLISH_STATUS"
SH
chmod +x "$tmp/bin/node"
setup_publish() {
  PATH="$tmp/bin:$PATH" PUBLISH_FIXTURE="$1" PUBLISH_STATUS="$2" PUBLISH_LOG="$tmp/publish.log" \
    bash -euc '. ./rollback.sh; db_issuers() { echo localhost; }; url=http://db; db=test; mcp_origin=https://mcp.example.com; DOMAIN=example.com; . "$1"; echo setup-continued' _ "$tmp/publish-block.sh" >"$tmp/setup.log" 2>&1
}
if setup_publish "$tmp/columns.log" 1 && grep -q 'kept the live module' "$tmp/setup.log" && grep -q 'setup-continued' "$tmp/setup.log"; then
  ok 'setup continues after a recognized publish refusal'
else bad 'setup continues after a recognized publish refusal'; fi
if setup_publish "$tmp/columns.log" 124; then bad 'setup rejects timeout status with a recognized log'; else
  status=$?
  [ "$status" = 124 ] && ok 'setup preserves timeout status' || bad "setup preserves timeout status: $status"
fi
# Leave an allowed log behind, then fail before the publisher writes a new one.
cp "$tmp/columns.log" "$tmp/publish.log"
if setup_publish '' 7; then bad 'setup rejects a pre-publish failure with a stale log'; else
  status=$?
  [ "$status" = 7 ] && ok 'setup preserves pre-publish failure despite a stale log' || bad "setup preserves pre-publish failure: $status"
fi
if setup_publish '' 0 && grep -q 'setup-continued' "$tmp/setup.log"; then
  ok 'setup continues after a successful publish'
else bad 'setup continues after a successful publish'; fi

[ "$fails" = 0 ] || { echo "$fails failed" >&2; exit 1; }
