#!/bin/sh
# sh docker/prod/scripts.test.sh: guard.sh refusals, runtime_config and own_networks.
# Linux only (GNU or busybox sed, as in the images).
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
env -i VITE_SPACETIME_URI=wss://board.example.com VITE_OIDC_ISSUER='https://id.example.com/realms/a?b=c' VITE_REQUIRE_AUTH= \
  sh -c '. ./guard.sh; . ./runtime-config.sh; runtime_config "$1" spacetime_uri oidc_issuer require_auth' _ "$tmp"
[ "$(cat "$tmp/app.js")" = 'const a={VITE_SPACETIME_URI:"wss://board.example.com"},b="https://id.example.com/realms/a?b=c",c="";' ] &&
  ok 'runtime_config writes the values' || bad "runtime_config writes the values: $(cat "$tmp/app.js")"
if env -i VITE_SPACETIME_URI='wss://x";alert(1);"' sh -c '. ./guard.sh; . ./runtime-config.sh; runtime_config "$1" spacetime_uri' _ "$tmp" 2>/dev/null; then
  bad 'runtime_config refuses a quote'
else ok 'runtime_config refuses a quote'; fi
for value in "https://x/'a" 'https://x/?a=1&b=2' 'https://x/a\b' 'https://x/a|b' "$(printf 'https://x/a\nb')"; do
  if env -i VITE_SPACETIME_URI="$value" sh -c '. ./guard.sh; . ./runtime-config.sh; runtime_config "$1" spacetime_uri' _ "$tmp" 2>/dev/null; then
    bad "runtime_config refuses $value"
  else ok "runtime_config refuses $value"; fi
done

printf 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\neth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\neth1\t0008A8C0\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0\n' >"$tmp/route"
[ "$(sh -c '. ./runtime-config.sh; own_networks "$1"' _ "$tmp/route" | paste -sd, -)" = '172.17.0.0/16,192.168.8.0/20' ] &&
  ok 'own_networks reads the routing table' || bad 'own_networks reads the routing table'

roles() { env -i "$@" sh -c '. ./runtime-config.sh; role_networks' | paste -sd, -; }
[ "$(roles VERSIONS_S3_ENDPOINT=https://s3.example.com)" = '169.254.169.254/32,169.254.170.2/32' ] &&
  ok 'role_networks opens the credential endpoints for Versions without keys' || bad 'role_networks opens the credential endpoints for Versions without keys'
[ -z "$(roles VERSIONS_S3_ENDPOINT=https://s3.example.com VERSIONS_S3_ACCESS_KEY_ID=key)" ] &&
  ok 'role_networks: none with keys' || bad 'role_networks: none with keys'
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

[ "$fails" = 0 ] || { echo "$fails failed" >&2; exit 1; }
