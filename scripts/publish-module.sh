#!/usr/bin/env bash
# Publishes module/ to one database without ever destroying its data.
# deploy-env.yml runs this after the compatibility and release-authority gates:
#
#   SPACETIME_SERVER=<nickname|host|url> SPACETIME_DB=<db> \
#   PUBLISH_YES_FLAGS=remote,skip-login,break-clients,migrate scripts/publish-module.sh
#
# Migration safety: this must never destroy live data.
#   - No `--delete-data` / `-c` flag, ever.
#   - Never bare `--yes` (it defaults to `all`, which silently answers the
#     "DESTROY all data" prompt). Only the specific prompts listed in
#     PUBLISH_YES_FLAGS are auto-answered; `delete-data` is deliberately
#     absent, so a publish that would require a data reset hits an
#     unanswerable prompt in a non-interactive job and fails.
#   - The check below rejects any destructive value in PUBLISH_YES_FLAGS
#     before anything is published.
# The module only rolls forward: nothing ever un-publishes it.
set -euo pipefail
: "${SPACETIME_SERVER:?set SPACETIME_SERVER}" "${SPACETIME_DB:?set SPACETIME_DB}" "${PUBLISH_YES_FLAGS:?set PUBLISH_YES_FLAGS}"

case ",${PUBLISH_YES_FLAGS}," in
  *,delete-data,*|*,all,*)
    echo "::error::PUBLISH_YES_FLAGS contains a destructive value (${PUBLISH_YES_FLAGS}). Refusing to publish."
    exit 1
    ;;
esac
echo "Publish will auto-answer only: ${PUBLISH_YES_FLAGS}"

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo/module"
set +e
# `spacetime publish` has been observed to hang, so cap it. A timeout (124)
# fails like any other error: nothing here can tell whether it applied.
timeout 600 spacetime publish \
  --server "$SPACETIME_SERVER" \
  --yes="$PUBLISH_YES_FLAGS" \
  "$SPACETIME_DB" 2>&1 | tee /tmp/publish.log
status=$?
set -e
if [ "$status" -eq 124 ]; then
  echo "::error::spacetime publish timed out after 600 s; the schema may not have changed. Re-run."
  exit "$status"
elif [ "$status" -ne 0 ]; then
  echo "::error::spacetime publish exited with $status (refused prompt?). Full CLI output above."
  exit "$status"
fi

# An update keeps each sender's stored view rows and the table reads the OLD
# code made, so a view whose logic changed goes stale until one of those
# tables changes (link sharing: visible_* never saw link visits). Every view
# reads public_board, so touching it once makes every sender's views rerun.
# The sentinel id names no board, so no view ever shows it.
sentinel=18446744073709551615
for stmt in "DELETE FROM public_board WHERE board_id = $sentinel" \
            "INSERT INTO public_board (board_id) VALUES ($sentinel)" \
            "DELETE FROM public_board WHERE board_id = $sentinel"; do
  if ! spacetime sql --server "$SPACETIME_SERVER" "$SPACETIME_DB" "$stmt" >/dev/null; then
    echo "::error::published, but refreshing views failed ($stmt). Re-run so stale views catch up."
    exit 1
  fi
done
echo "Views refreshed."
