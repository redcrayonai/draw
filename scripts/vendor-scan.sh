#!/usr/bin/env bash
# The vendor scan (spec §12 Vendor invisibility); see scripts/vendor-scan.mjs.
# Build the targets first: pnpm -C mcp run surface (bundle + tool texts).
exec node "$(dirname "$0")/vendor-scan.mjs" "$@"
