#!/usr/bin/env bash
# Exercises the build-companion module surface (PR1) against a running local
# SpacetimeDB. Run inside the nix dev shell from the repo root:
#
#   nix develop --command bash -c 'scripts/verify-module-local.sh'
#
# Assumes module/ has been published to the target database (CONTRIBUTING.md
# "Package checks"). Creates one scratch session board named
# pr1-verify-<epoch> and leaves it in place (local dev database).
# SPACETIME_ROOT_DIR runs the CLI with --root-dir; scripts/stdb-test.sh legacy
# uses it to point this script at the isolated test server.
set -euo pipefail

DB="${SPACETIME_DB:-redcrayon}"
SERVER="${SPACETIME_SERVER:-local}"
EMPTY_TREE_SHA=4b825dc642cb6eb9a060e54bf8d69288fbee4904
NAME="pr1-verify-$(date +%s)"

st() { if [ -n "${SPACETIME_ROOT_DIR:-}" ]; then spacetime --root-dir "$SPACETIME_ROOT_DIR" "$@"; else spacetime "$@"; fi; }
call() { st call --no-config --server "$SERVER" "$DB" "$@" 2>&1 | grep -v '^WARNING:' || true; }
sql()  { st sql  --no-config --server "$SERVER" "$DB" "$1" 2>&1 | grep -v '^WARNING:' || true; }
# first cell of the first row of a --format json query
cell() {
  st sql --no-config --server "$SERVER" "$DB" --format json "$1" 2>/dev/null \
    | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); const v=r[0].rows[0]?.[0]; if(v===undefined){process.exit(2)} console.log(String(v))'
}
rows() {
  st sql --no-config --server "$SERVER" "$DB" --format json "$1" 2>/dev/null \
    | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(r[0].rows.length)'
}

pass=0; failn=0
ok()   { echo "PASS  $1"; pass=$((pass+1)); }
bad()  { echo "FAIL  $1"; echo "      $2"; failn=$((failn+1)); }
# expect_ok <label> <call args…>
expect_ok() { local label="$1"; shift; local out; out="$(call "$@")"; if [ -z "$out" ]; then ok "$label"; else bad "$label" "$out"; fi; }
# expect_reject <label> <needle> <call args…>
expect_reject() { local label="$1" needle="$2"; shift 2; local out; out="$(call "$@")"; if [[ "$out" == *"$needle"* ]]; then ok "$label"; else bad "$label" "expected '$needle', got: $out"; fi; }

echo "database $DB on $SERVER, scratch board $NAME"

# RC-690: the refs and citations below carry code text, which a board keeps only with its owner's consent
expect_ok "set_code_consent: this identity's boards keep code snippets" set_code_consent true

# 1. session resumed after a Claude Code restart (review-focus test 4):
#    start_session, seed three repo_file rows (what the MCP server does after
#    start_session), then start_session again with the same name. The second
#    call must re-adopt the SAME board, leave exactly one session row, and
#    seed no duplicate repo_file rows (add_repo_files is idempotent, P1.9).
expect_ok "start_session creates the board" start_session "\"$NAME\"" "\"/tmp/$NAME\"" "\"$EMPTY_TREE_SHA\""
BOARD="$(cell "SELECT id FROM board WHERE name = '$NAME'")"
expect_ok "add_repo_files seeds three paths" add_repo_files "$BOARD" '["src/limiter.ts","src/store.ts","src/main.ts"]'
expect_ok "start_session again (restart) is a no-op" start_session "\"$NAME\"" "\"/tmp/$NAME\"" "\"$EMPTY_TREE_SHA\""
BOARD2="$(cell "SELECT id FROM board WHERE name = '$NAME'")"
[ "$BOARD" = "$BOARD2" ] && ok "same board id after restart ($BOARD)" || bad "board id changed" "before $BOARD, after $BOARD2"
[ "$(rows "SELECT id FROM board WHERE name = '$NAME'")" = "1" ] && ok "exactly one board named $NAME" || bad "board count" "$(sql "SELECT id, name FROM board WHERE name = '$NAME'")"
[ "$(rows "SELECT id FROM session WHERE board_id = $BOARD")" = "1" ] && ok "exactly one session row (checkpoint $(cell "SELECT checkpoint FROM session WHERE board_id = $BOARD"))" || bad "session count" "$(sql "SELECT * FROM session WHERE board_id = $BOARD")"
expect_ok "re-seed after restart" add_repo_files "$BOARD" '["src/limiter.ts","src/store.ts","src/main.ts"]'
[ "$(rows "SELECT id FROM repo_file WHERE board_id = $BOARD")" = "3" ] && ok "no duplicate repo_file rows after restart (3)" || bad "repo_file duplicated" "$(sql "SELECT id, path FROM repo_file WHERE board_id = $BOARD")"

# 1b. F3: a same-named session from another checkout is refused (the stored
#     repoRoot would otherwise win silently); a later hand-made board with the
#     same name does not stop the session board from being re-adopted.
expect_reject "start_session from another checkout is refused" "session board '$NAME' belongs to /tmp/$NAME; start_session from that checkout or choose another name" \
  start_session "\"$NAME\"" "\"/tmp/$NAME-other\"" "\"$EMPTY_TREE_SHA\""
[ "$(cell "SELECT repo_root FROM session WHERE board_id = $BOARD")" = "/tmp/$NAME" ] && ok "repoRoot unchanged after the refused start" || bad "repoRoot changed" "$(sql "SELECT * FROM session WHERE board_id = $BOARD")"
expect_ok "create_board: a hand-made board with the session's name" create_board "\"$NAME\""
expect_ok "start_session re-adopts the session board despite the hand-made twin" start_session "\"$NAME\"" "\"/tmp/$NAME\"" "\"$EMPTY_TREE_SHA\""
[ "$(rows "SELECT id FROM session WHERE board_id = $BOARD")" = "1" ] && ok "still one session row on board $BOARD" || bad "session count after twin" "$(sql "SELECT * FROM session WHERE board_id = $BOARD")"
# G21: a name only a hand-made board uses is refused with the name and a next step
expect_ok "create_board: a hand-made board no session uses" create_board "\"$NAME-hand\""
expect_reject "start_session on the hand-made board's name names it and suggests another" \
  "board '$NAME-hand' already exists without a session (someone made it by hand); call start_session with another name, e.g. '$NAME-hand-session'" \
  start_session "\"$NAME-hand\"" "\"/tmp/$NAME\"" "\"$EMPTY_TREE_SHA\""
[ "$(rows "SELECT id FROM board WHERE name = '$NAME-hand'")" = "1" ] && ok "the refused start_session created no board" || bad "board count after refusal" "$(sql "SELECT id, name FROM board WHERE name = '$NAME-hand'")"
# ...and the suggested name itself fits the 100-character limit
HAND100="$NAME-hand100-$(printf 'y%.0s' $(seq 1 100))"; HAND100="${HAND100:0:100}"
expect_ok "create_board: a hand-made board with a 100-character name" create_board "\"$HAND100\""
expect_reject "start_session on it suggests a name of at most 100 characters" \
  "call start_session with another name, e.g. '${HAND100:0:92}-session'" \
  start_session "\"$HAND100\"" "\"/tmp/$NAME\"" "\"$EMPTY_TREE_SHA\""

# 1c. F5: start_session bounds the name (one short line) and needs an absolute
#     repoRoot; nothing is created for a refused call.
LONG="$NAME-$(printf 'x%.0s' $(seq 1 101))"; LONG="${LONG:0:101}"   # unique per run, exactly 101 characters
expect_reject "start_session rejects an empty name" "session name must be one short line, e.g. the git branch" \
  start_session '""' "\"/tmp/$NAME\"" "\"$EMPTY_TREE_SHA\""
expect_reject "start_session rejects a multi-line name" "session name must be one short line, e.g. the git branch" \
  start_session "\"$NAME-multi\\nline\"" "\"/tmp/$NAME\"" "\"$EMPTY_TREE_SHA\""
expect_reject "start_session rejects a 101-character name" "session name must be one short line, e.g. the git branch" \
  start_session "\"$LONG\"" "\"/tmp/$NAME\"" "\"$EMPTY_TREE_SHA\""
expect_reject "start_session rejects a relative repoRoot" "repoRoot must be an absolute path on one line" \
  start_session "\"$NAME-rel\"" '"tmp/relative"' "\"$EMPTY_TREE_SHA\""
expect_reject "start_session rejects a repoRoot with a control character" "repoRoot must be an absolute path on one line" \
  start_session "\"$NAME-ctl\"" '"/tmp/a\tb"' "\"$EMPTY_TREE_SHA\""
[ "$(rows "SELECT id FROM board WHERE name = '$NAME-rel'")" = "0" ] && [ "$(rows "SELECT id FROM board WHERE name = '$NAME-ctl'")" = "0" ] && [ "$(rows "SELECT id FROM board WHERE name = '$LONG'")" = "0" ] \
  && ok "no board created by a refused start_session" || bad "refused start_session created a board" "$(sql "SELECT id, name FROM board WHERE name = '$NAME-rel' OR name = '$NAME-ctl' OR name = '$LONG'")"

# 2. a node and the registered path (dedupe again, single path form)
NONE='{"none":[]}'
expect_ok "create_node" create_node "$BOARD" '"Limiter"' '"token bucket"' 0 0 160 80 '"ink"' false "$NONE" "$NONE" "$NONE" "$NONE" "$NONE" "$NONE" "$NONE"
NODE="$(cell "SELECT id FROM node WHERE board_id = $BOARD")"
expect_ok "add_repo_files again (dedupe)" add_repo_files "$BOARD" '["src/limiter.ts"]'
[ "$(rows "SELECT id FROM repo_file WHERE board_id = $BOARD")" = "3" ] && ok "repo_file still three rows" || bad "repo_file dedupe" "$(sql "SELECT id, path FROM repo_file WHERE board_id = $BOARD")"

# 3. code refs: one accepted, two rejected
expect_ok "add_code_ref accepted" add_code_ref "$BOARD" '"node"' "$NODE" '"src/limiter.ts"' '"Limiter.allow"' 10 12 "\"$EMPTY_TREE_SHA\"" '"  allow(): boolean {\n    return true;\n  }"' '""'
expect_reject "add_code_ref rejected: symbol not in snippet" "does not occur in the snippet" \
  add_code_ref "$BOARD" '"node"' "$NODE" '"src/limiter.ts"' '"Limiter.deny"' 10 12 "\"$EMPTY_TREE_SHA\"" '"  allow(): boolean {}"' '""'
expect_reject "add_code_ref rejected: unregistered path" "code ref rule: source path 'src/zzz.ts' does not exist" \
  add_code_ref "$BOARD" '"node"' "$NODE" '"src/zzz.ts"' '"allow"' 1 1 "\"$EMPTY_TREE_SHA\"" '"allow"' '""'
# F17: the same target + path + symbol is one ref; a retry names the existing row
REF="$(cell "SELECT id FROM code_ref WHERE target_id = $NODE")"
expect_reject "add_code_ref again (same target/path/symbol) is already attached" "already attached id=$REF src/limiter.ts:10-12" \
  add_code_ref "$BOARD" '"node"' "$NODE" '"src/limiter.ts"' '"Limiter.allow"' 20 22 "\"$EMPTY_TREE_SHA\"" '"  allow(): boolean {\n    return false;\n  }"' '""'
# F18: a symbol whose last dotted segment is empty names nothing
expect_reject "add_code_ref rejected: symbol ends with a dot" "code ref rule: symbol 'Limiter.' ends with a dot" \
  add_code_ref "$BOARD" '"node"' "$NODE" '"src/limiter.ts"' '"Limiter."' 1 1 "\"$EMPTY_TREE_SHA\"" '"Limiter."' '""'
[ "$(rows "SELECT id FROM code_ref WHERE target_id = $NODE")" = "1" ] && ok "one code_ref row on node $NODE (status $(cell "SELECT status FROM code_ref WHERE target_id = $NODE"), checkpoint $(cell "SELECT checkpoint FROM code_ref WHERE target_id = $NODE"))" || bad "code_ref count" "$(sql "SELECT * FROM code_ref WHERE target_id = $NODE")"

# 3b. RC-538: source evidence keeps its original line capture while checkpoints
#     move the citation or mark it stale. Missing captures cannot be promoted.
expect_ok "create_node: source evidence target" create_node "$BOARD" '"Store"' '"evidence target"' 200 0 160 80 '"ink"' false "$NONE" "$NONE" "$NONE" "$NONE" "$NONE" "$NONE" "$NONE"
TARGET="$(cell "SELECT id FROM node WHERE board_id = $BOARD AND label = 'Store'")"
CAPTURE='{"some":"  return limiter.allow();"}'
expect_ok "create_edge captures a source line" create_edge "$BOARD" "$NODE" "$TARGET" '"source capture"' '"source:src/limiter.ts:10"' "$NONE" "$CAPTURE" "$NONE"
EDGE="$(cell "SELECT id FROM edge WHERE board_id = $BOARD AND label = 'source capture'")"
[ "$(cell "SELECT evidence_snippet FROM edge WHERE id = $EDGE")" = "  return limiter.allow();" ] && [ "$(cell "SELECT evidence_status FROM edge WHERE id = $EDGE")" = "ok" ] \
  && ok "source capture is stored exactly with status ok" || bad "source capture" "$(sql "SELECT evidence, evidence_snippet, evidence_status FROM edge WHERE id = $EDGE")"
expect_ok "update_edge_evidence shifts the same source path" update_edge_evidence "$EDGE" '"source:src/limiter.ts:20"' '"ok"'
[ "$(rows "SELECT id FROM edge WHERE id = $EDGE AND evidence = 'source:src/limiter.ts:20' AND evidence_snippet = '  return limiter.allow();' AND evidence_status = 'ok'")" = "1" ] \
  && ok "shifted citation retains the original capture" || bad "shifted source evidence" "$(sql "SELECT evidence, evidence_snippet, evidence_status FROM edge WHERE id = $EDGE")"
expect_ok "update_edge_evidence marks a captured source stale" update_edge_evidence "$EDGE" '"source:src/limiter.ts:20"' '"stale"'
[ "$(rows "SELECT id FROM edge WHERE id = $EDGE AND evidence = 'source:src/limiter.ts:20' AND evidence_snippet = '  return limiter.allow();' AND evidence_status = 'stale'")" = "1" ] \
  && ok "stale source retains its citation and capture" || bad "stale source evidence" "$(sql "SELECT evidence, evidence_snippet, evidence_status FROM edge WHERE id = $EDGE")"
expect_ok "update_edge_evidence restores the original citation" update_edge_evidence "$EDGE" '"source:src/limiter.ts:10"' '"ok"'
[ "$(rows "SELECT id FROM edge WHERE id = $EDGE AND evidence = 'source:src/limiter.ts:10' AND evidence_snippet = '  return limiter.allow();' AND evidence_status = 'ok'")" = "1" ] \
  && ok "restored citation retains the original capture" || bad "restored source evidence" "$(sql "SELECT evidence, evidence_snippet, evidence_status FROM edge WHERE id = $EDGE")"

expect_ok "create_edge restores captured stale evidence for undo" create_edge "$BOARD" "$NODE" "$TARGET" '"stale source restore"' '"source:src/limiter.ts:20"' "$NONE" "$CAPTURE" '{"some":"stale"}'
[ "$(rows "SELECT id FROM edge WHERE board_id = $BOARD AND label = 'stale source restore' AND evidence_snippet = '  return limiter.allow();' AND evidence_status = 'stale'")" = "1" ] \
  && ok "undo preserves a stale capture" || bad "stale capture restore" "$(sql "SELECT evidence, evidence_snippet, evidence_status FROM edge WHERE board_id = $BOARD AND label = 'stale source restore'")"
expect_ok "create_edge without a source capture defaults stale" create_edge "$BOARD" "$NODE" "$TARGET" '"missing source capture"' '"source:src/limiter.ts:10"' "$NONE" "$NONE" "$NONE"
MISSING_EDGE="$(cell "SELECT id FROM edge WHERE board_id = $BOARD AND label = 'missing source capture'")"
expect_ok "update_edge_evidence keeps uncaptured source evidence stale" update_edge_evidence "$MISSING_EDGE" '"source:src/limiter.ts:10"' '"stale"'
[ "$(rows "SELECT id FROM edge WHERE id = $MISSING_EDGE AND evidence_snippet = '' AND evidence_status = 'stale'")" = "1" ] \
  && ok "missing source capture is empty and stale" || bad "missing source capture" "$(sql "SELECT evidence, evidence_snippet, evidence_status FROM edge WHERE id = $MISSING_EDGE")"
expect_reject "update_edge_evidence cannot promote a missing capture" "ok source evidence requires a captured line" \
  update_edge_evidence "$MISSING_EDGE" '"source:src/limiter.ts:10"' '"ok"'
# RC-690: undo restores an ok citation whose text was wiped or never filled; its hash follows in set_edge_evidence_code.
expect_ok "create_edge restores an ok citation without its capture" \
  create_edge "$BOARD" "$NODE" "$TARGET" '"ok source restore"' '"source:src/limiter.ts:10"' "$NONE" "$NONE" '{"some":"ok"}'
expect_ok "create_edge restores legacy line zero with empty source metadata" create_edge "$BOARD" "$NODE" "$TARGET" '"legacy source restore"' '"source:src/limiter.ts:0"' "$NONE" '{"some":""}' '{"some":""}'
LEGACY_EDGE="$(cell "SELECT id FROM edge WHERE board_id = $BOARD AND label = 'legacy source restore'")"
expect_ok "update_edge_evidence keeps legacy line zero stale" update_edge_evidence "$LEGACY_EDGE" '"source:src/limiter.ts:0"' '"stale"'
expect_reject "update_edge_evidence cannot promote legacy line zero without a capture" "ok source evidence requires a captured line" \
  update_edge_evidence "$LEGACY_EDGE" '"source:src/limiter.ts:0"' '"ok"'
[ "$(rows "SELECT id FROM edge WHERE id = $LEGACY_EDGE AND evidence = 'source:src/limiter.ts:0' AND evidence_snippet = '' AND evidence_status = 'stale'")" = "1" ] \
  && ok "restored legacy source metadata defaults stale" || bad "legacy source metadata" "$(sql "SELECT evidence, evidence_snippet, evidence_status FROM edge WHERE id = $LEGACY_EDGE")"
expect_ok "delete_edge: legacy source restore" delete_edge "$LEGACY_EDGE"

expect_ok "create_edge import keeps source metadata empty" create_edge "$BOARD" "$NODE" "$TARGET" '"import evidence"' '"import"' "$NONE" "$NONE" "$NONE"
IMPORT_EDGE="$(cell "SELECT id FROM edge WHERE board_id = $BOARD AND label = 'import evidence'")"
[ "$(rows "SELECT id FROM edge WHERE id = $IMPORT_EDGE AND evidence_snippet = '' AND evidence_status = ''")" = "1" ] \
  && ok "non-source evidence has no source metadata" || bad "non-source evidence" "$(sql "SELECT evidence, evidence_snippet, evidence_status FROM edge WHERE id = $IMPORT_EDGE")"
expect_reject "create_edge rejects a capture on import evidence" "only source citations carry captured evidence" \
  create_edge "$BOARD" "$NODE" "$TARGET" '"invalid import capture"' '"import"' "$NONE" "$CAPTURE" "$NONE"
expect_reject "create_edge rejects a source status on import evidence" "only source citations carry captured evidence" \
  create_edge "$BOARD" "$NODE" "$TARGET" '"invalid import status"' '"import"' "$NONE" "$NONE" '{"some":"stale"}'
expect_reject "update_edge_evidence rejects a different registered source path" "re-anchoring must keep the source path" \
  update_edge_evidence "$EDGE" '"source:src/store.ts:10"' '"ok"'
expect_reject "update_edge_evidence rejects a non-source citation" "source" \
  update_edge_evidence "$EDGE" '"import"' '"ok"'
expect_reject "update_edge_evidence cannot convert an import edge to source" "source" \
  update_edge_evidence "$IMPORT_EDGE" '"source:src/limiter.ts:10"' '"stale"'
expect_reject "update_edge_evidence rejects an invalid status" "source status must be ok or stale" \
  update_edge_evidence "$EDGE" '"source:src/limiter.ts:10"' '"missing"'
expect_reject "create_edge rejects an invalid source status" "source status must be ok or stale" \
  create_edge "$BOARD" "$NODE" "$TARGET" '"invalid source status"' '"source:src/limiter.ts:10"' "$NONE" "$CAPTURE" '{"some":"missing"}'
expect_reject "update_edge_evidence rejects source line zero" "source citation line" \
  update_edge_evidence "$EDGE" '"source:src/limiter.ts:0"' '"ok"'
expect_reject "create_edge rejects source line zero with a capture" "source citation line" \
  create_edge "$BOARD" "$NODE" "$TARGET" '"invalid source line"' '"source:src/limiter.ts:0"' "$NONE" "$CAPTURE" "$NONE"
expect_reject "create_edge rejects a negative source line" "source citation line" \
  create_edge "$BOARD" "$NODE" "$TARGET" '"invalid source line"' '"source:src/limiter.ts:-1"' "$NONE" "$CAPTURE" "$NONE"
expect_reject "create_edge rejects a fractional source line" "source citation line" \
  create_edge "$BOARD" "$NODE" "$TARGET" '"invalid source line"' '"source:src/limiter.ts:1.5"' "$NONE" "$CAPTURE" "$NONE"
expect_reject "create_edge rejects a multiline source capture" "captured source line must be one nonblank line" \
  create_edge "$BOARD" "$NODE" "$TARGET" '"invalid source capture"' '"source:src/limiter.ts:10"' "$NONE" '{"some":"return limiter.allow();\nreturn false;"}' "$NONE"
expect_reject "create_edge rejects a blank source capture" "captured source line must be one nonblank line" \
  create_edge "$BOARD" "$NODE" "$TARGET" '"invalid source capture"' '"source:src/limiter.ts:10"' "$NONE" '{"some":"   "}' "$NONE"
[ "$(rows "SELECT id FROM edge WHERE id = $EDGE AND evidence = 'source:src/limiter.ts:10' AND evidence_snippet = '  return limiter.allow();' AND evidence_status = 'ok'")" = "1" ] \
  && ok "rejected updates leave the source evidence unchanged" || bad "rejected update changed evidence" "$(sql "SELECT evidence, evidence_snippet, evidence_status FROM edge WHERE id = $EDGE")"
[ "$(rows "SELECT id FROM edge WHERE board_id = $BOARD")" = "5" ] \
  && ok "rejected creates add no edges" || bad "rejected create added an edge" "$(sql "SELECT id, label FROM edge WHERE board_id = $BOARD")"

# 4. cascade
expect_ok "delete_node" delete_node "$NODE"
[ "$(rows "SELECT id FROM code_ref WHERE target_id = $NODE")" = "0" ] && ok "code_ref cascaded with the node" || bad "cascade" "$(sql "SELECT id, target_kind, target_id FROM code_ref WHERE target_id = $NODE")"
[ "$(rows "SELECT id FROM edge WHERE board_id = $BOARD")" = "0" ] && ok "source evidence edges cascaded with the node" || bad "edge cascade" "$(sql "SELECT id, from_node, to_node FROM edge WHERE board_id = $BOARD")"
expect_ok "delete_node: source evidence target" delete_node "$TARGET"

echo
echo "$pass passed, $failn failed"
[ "$failn" -eq 0 ]
