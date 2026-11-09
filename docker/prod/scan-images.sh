#!/bin/sh
# docker/prod/scan-images.sh [tag] [--enforce]: scripts/vendor-scan.mjs over the
# files each self-host image adds (/app), from the repo root after a build.
#   private  every image's /app: no auth vendor, hosted account or production host
#            (enforced, as for the public tree)
#   bundle   the mcp Worker: no database vendor word, no source map, as hosted
#   CANARY=<value>: no layer of any image holds it (a build secret, docker/prod/smoke/outside.sh)
# The canvas and dashboard bundles still name the database (the client SDK, the
# server's settings), as their hosted builds do; they become `bundle` targets
# when vendor-scan.targets takes the hosted ones.
set -eu
tag=${1:-dev}
[ $# -eq 0 ] || shift
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
for image in canvas dashboard mcp module-setup importer; do
  container="$(docker create "ghcr.io/redcrayonai/redcrayon-$image:$tag")"
  mkdir -p "$out/$image"
  docker cp -q "$container:/app" "$out/$image/app"
  docker rm "$container" >/dev/null
  echo "private $out/$image/app" >>"$out/targets"
done
echo "bundle $out/mcp/app/mcp/worker.js" >>"$out/targets"
if [ -n "${CANARY:-}" ]; then
  for image in canvas dashboard mcp module-setup; do
    if docker save "ghcr.io/redcrayonai/redcrayon-$image:$tag" | grep -aqF "$CANARY"; then
      echo "scan-images: the build secret is in redcrayon-$image:$tag" >&2
      exit 1
    fi
  done
  echo "scan-images: no image holds the build secret"
fi
node scripts/vendor-scan.mjs "$out/targets" "$@"
