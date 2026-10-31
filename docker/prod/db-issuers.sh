# db_issuers <database url> <CLI config file>: the DB_ISSUERS module-setup.sh publishes with (RC-571).
# The issuer rule refuses senders outside the allowlist, and the setup's SQL connects as the owner's
# saved CLI login, so it admits the issuer of the host's anonymous tokens (guests) and of that login,
# read rather than assumed to be `localhost`. With no saved login yet (a first install) the publish
# makes a server-issued one, which has the anonymous tokens' issuer.
iss_of() { node -e 'try { console.log(JSON.parse(Buffer.from(process.argv[1].split(".")[1], "base64url")).iss ?? "") } catch { console.log("") }' "$1"; }
db_issuers() {
  anon="$(iss_of "$(curl -sf -X POST "$1/v1/identity" | node -e 'let s = ""; process.stdin.on("data", d => s += d).on("end", () => { try { console.log(JSON.parse(s).token) } catch { console.log("") } })')")"
  [ -n "$anon" ] || { echo "module-setup: cannot read the issuer of $1's anonymous tokens." >&2; return 1; }
  owner="$(sed -n 's/^spacetimedb_token = "\(.*\)"$/\1/p' "$2" 2>/dev/null || true)"
  if [ -n "$owner" ]; then echo "$anon,$(iss_of "$owner")"; else echo "$anon"; fi
}
