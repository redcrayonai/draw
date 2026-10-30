# Sourced by the canvas and dashboard entrypoints. runtime_config <dir> <name>...
# writes the container's VITE_<NAME> values over the build's __rc_<name>__
# placeholders in every .js and .html file under <dir> (see Dockerfile).
runtime_config() {
  dir=$1
  shift
  script=''
  for name; do
    var="VITE_$(echo "$name" | tr a-z A-Z)"
    value="$(printenv "$var" || true)"
    # The value lands inside a JavaScript string ('…' or "…") and a sed replacement:
    # URL characters only, without quotes, backslash, newline, & (the sed match) or | (its delimiter).
    case "$value" in *[!A-Za-z0-9._~:/?#@!\$\(\)*+,\;=%-]*) die "$var may only hold URL characters, without quotes, backslashes, & or |." ;; esac
    script="${script}s|__rc_${name}__|${value}|g
"
  done
  find "$dir" -type f \( -name '*.js' -o -name '*.html' \) -exec sed -i "$script" {} +
}

# own_networks [route file]: the networks this container is attached to, one
# CIDR per line, from its routing table (the default route left out). The
# Workers' outbound allow-list: the stack's network, whatever subnet it got.
own_networks() {
  while read -r _ dest _ _ _ _ _ mask _; do
    case "$dest" in Destination | 00000000) continue ;; esac
    # little-endian hex: 000011AC + 0000FFFF -> 172.17.0.0/16
    set -- $(echo "$dest$mask" | sed 's/\(..\)\(..\)\(..\)\(..\)\(..\)\(..\)\(..\)\(..\)/\4 \3 \2 \1 \8 \7 \6 \5/')
    bits=0
    for byte in "$5" "$6" "$7" "$8"; do
      case "$byte" in FF) bits=$((bits + 8)) ;; FE) bits=$((bits + 7)) ;; FC) bits=$((bits + 6)) ;; F8) bits=$((bits + 5)) ;;
        F0) bits=$((bits + 4)) ;; E0) bits=$((bits + 3)) ;; C0) bits=$((bits + 2)) ;; 80) bits=$((bits + 1)) ;; esac
    done
    printf '%d.%d.%d.%d/%d\n' "0x$1" "0x$2" "0x$3" "0x$4" "$bits"
  done <"${1:-/proc/net/route}"
}
