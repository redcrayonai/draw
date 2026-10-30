#!/bin/sh
# check-placeholders.sh <dir> <name>...: every __rc_<name>__ placeholder is
# still in a file under <dir> (the build kept it for runtime-config.sh).
set -eu
dir=$1
shift
for name; do
  grep -rqF "__rc_${name}__" "$dir" || { echo "check-placeholders: __rc_${name}__ is not in $dir; runtime-config.sh could not set it" >&2; exit 1; }
done
