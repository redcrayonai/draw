# Sourced by every self-host entrypoint: refuse settings that are unsafe in
# production before anything starts. POSIX sh (the canvas image is busybox).

die() {
  echo "refusing to start: $*" >&2
  exit 1
}

# DEV_AUTH makes every caller on localhost the dev user.
guard_dev_auth() {
  case "${DEV_AUTH:-}" in '' | 0) ;; *) die "DEV_AUTH is set. It is for local development only; remove it." ;; esac
}

# VITE_AUTH_PROVIDER: anonymous (no accounts) or oidc. Requiring sign-in with
# no sign-in to offer is a misconfiguration, not a locked-down board.
guard_auth() {
  case "${VITE_AUTH_PROVIDER:-anonymous}" in
    anonymous)
      case "${VITE_REQUIRE_AUTH:-}" in 1 | [Tt][Rr][Uu][Ee]) die "VITE_REQUIRE_AUTH=1 needs VITE_AUTH_PROVIDER=oidc; anonymous has no sign-in." ;; esac ;;
    oidc)
      [ -n "${VITE_OIDC_ISSUER:-}" ] && [ -n "${VITE_OIDC_CLIENT_ID:-}" ] || die "VITE_AUTH_PROVIDER=oidc needs VITE_OIDC_ISSUER and VITE_OIDC_CLIENT_ID." ;;
    *) die "VITE_AUTH_PROVIDER must be anonymous or oidc, not '${VITE_AUTH_PROVIDER}'." ;;
  esac
}

# guard_secret <name>...: set, not an example value, 16+ characters, and safe
# to put in a URL (generate with: openssl rand -hex 32).
guard_secret() {
  for name; do
    value="$(printenv "$name" || true)"
    [ -n "$value" ] || die "$name is not set."
    case "$value" in *change-me* | *changeme*) die "$name still has an example value; generate one with: openssl rand -hex 32" ;; esac
    [ "${#value}" -ge 16 ] || die "$name is shorter than 16 characters; generate one with: openssl rand -hex 32"
    case "$value" in *[!A-Za-z0-9_-]*) die "$name may only hold letters, digits, '-' and '_' (it goes into a URL)." ;; esac
  done
}

# MCP_API_KEYS holds hashes, never keys; an example entry left in is refused.
guard_api_keys() {
  case "${MCP_API_KEYS:-}" in *change-me* | *changeme* | *'<'*) die "MCP_API_KEYS still has an example entry." ;; esac
}
