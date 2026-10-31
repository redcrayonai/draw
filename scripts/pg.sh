#!/usr/bin/env bash
# Project-local Postgres for the dashboard (web/). Data lives in .postgres/
# (gitignored). Run inside the nix dev shell from the repo root:
#
#   nix develop --command bash -c 'scripts/pg.sh start'    # start|stop|status
#   PGPORT=5433 scripts/pg.sh start                         # another worktree already has 5432
#
# `start` prints the DATABASE_URL to put in web/.env.local; `pnpm db:migrate`
# (dbmate up) creates the redcrayon database on first run.
set -euo pipefail

data="$(cd "$(dirname "$0")/.." && pwd)/.postgres"
port="${PGPORT:-5432}"

case "${1:-start}" in
  start)
    [ -f "$data/PG_VERSION" ] || initdb -D "$data" -U postgres --auth=trust --no-locale -E UTF8 >/dev/null
    if pg_ctl -D "$data" status >/dev/null 2>&1; then
      # Already running: its real port is line 4 of postmaster.pid, not $PGPORT.
      running="$(sed -n 4p "$data/postmaster.pid")"
      if [ "$running" != "$port" ]; then
        echo "Postgres from .postgres/ is already running on port $running, not $port. Rerun with PGPORT=$running, or run scripts/pg.sh stop first." >&2
        exit 1
      fi
    else
      pg_ctl -D "$data" -l "$data/server.log" -w -o "-p $port -k /tmp -c listen_addresses=localhost" start >/dev/null
    fi
    echo "DATABASE_URL=postgres://postgres@localhost:$port/redcrayon?sslmode=disable"
    ;;
  stop) pg_ctl -D "$data" stop ;;
  status) pg_ctl -D "$data" status ;;
  *)
    echo "usage: $0 start|stop|status" >&2
    exit 2
    ;;
esac
