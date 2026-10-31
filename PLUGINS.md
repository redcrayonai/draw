# Plugins and Versions

Design record for optional first-party plugins and the first one, Versions.
User docs: [Versions](docs/src/content/docs/capabilities/versions.md).
Operator setup: [SELF_HOSTING.md](SELF_HOSTING.md#versions-optional).

## Plugins

A plugin is an optional feature that ships in this repository and is off until
someone turns it on. There is no marketplace, no code installation, no sandbox
and no event bus. Two switches decide whether it runs:

| Switch | Who | Where | Effect |
|---|---|---|---|
| Deployment | The operator | Server settings. A plugin is offered only when every variable it needs is set (`web/src/lib/server/plugins.ts`). | Unoffered plugins show as "not configured" and their API answers `UNAVAILABLE`. |
| Workspace | A workspace owner or admin | `workspace_plugin` row through `set_workspace_plugin` (`module/src/plugins.ts`). | Off by default. Off stops every action of the plugin in that workspace and keeps its data. |

Members see their workspaces' switches through the `my_workspace_plugins` view.
The dashboard lists offered plugins under **Settings › Plugins**.

To add a plugin:

1. Add its id to `PLUGINS` in `module/src/plugins.ts`. Check `pluginEnabled(ctx, workspaceId, id)` in every reducer, procedure and view it adds.
2. Put its tables and reducers in their own module file, exported as a group from `index.ts` (as `versions.ts`). Its tables go into `LEFT_OUT` in `module/src/board-bundle.ts` unless they are board content.
3. Add an entry to `PLUGINS` in `web/src/lib/server/plugins.ts` with the variables it needs. Bind each variable in `docker/prod/dashboard.capnp`, `compose.prod.yml`, `docker-compose.yml` and `.env.example`.

## Versions

A version is a complete copy of one board at one moment, kept outside the
database. People list a board's versions and restore any of them into a new
private board. The original board never changes.

The model is a file's version history in a drive or an object store's
versioning: one list per board, newest first, each entry a whole copy with its
time and author. Two differences are deliberate. A person saves a version; edits
do not make one. A restore makes a copy (`restore as copy`) instead of rolling the
board back, because the board is live and shared.

Scope of this first release: manual save, list, restore. No schedules,
retention, deletion, cold storage, thumbnails or diffs. No MCP tool: agents
cannot save or restore.

### Ownership

| Core (any plugin may use it) | Versions plugin |
|---|---|
| Bundle format, capture and restore: `module/src/board-bundle.ts` | Version index `board_version`, restore staging `board_version_chunk`: `module/src/versions.ts` |
| SHA-256 in the module: `module/src/sha256.ts` | Save, list and restore rules and actions |
| Workspace plugin switch: `module/src/plugins.ts` | Object storage and its settings: `web/src/lib/server/versions.ts` |
| Board access (`humanBoardRole`, workspace roles) | Dashboard UI: `BoardVersions.svelte`, `/workspaces/plugins` |
| S3-compatible client: `web/src/lib/server/object-store.ts` | |

### Save

1. The dashboard server calls the procedure `capture_board_version(boardId)` **as the person**.
   In one transaction the module checks access and the workspace switch, reads every
   board-owned row, encodes the bundle, parses it back (a board a restore would refuse
   is refused now), and inserts a `pending` index row. The row holds the object key,
   the file's SHA-256 and byte length. The key is `versions/w<workspace>/b<board>/<uuid v7>.json`,
   unique per version (a same-microsecond twin gets a `-n` suffix).
2. The server writes the object with `If-None-Match: *` and a signed payload hash.
   A store or network failure is tried up to 3 times in all. When the key is taken, the server
   accepts it only if the stored bytes have the same SHA-256 (an earlier try of the same
   write); otherwise it stops and lists nothing. No write replaces an object, and nothing
   depends on bucket versioning.
3. Only then the server calls `publish_board_version(id, sha256)` **as the service**.
   The module checks that the saver still has edit access and the plugin is still on,
   and marks the row `ready`. Only `ready` rows are listed.

Capture is a procedure because a reducer cannot return the bundle. `withTx`
makes it one serializable transaction, so concurrent edits are either wholly in
the bundle or wholly out of it.

Both procedures (`capture_board_version`, `restore_board_version`) spend their
write in a transaction of their own before the work, so a refused or failed call
still costs one write from the caller's budget. A reducer's refusal rolls its
spend back, which would make these large reads and checksums free to repeat. They
answer JSON: the result, or `{ error, refused }`, where `refused` marks a rule's
refusal (`REJECTED`) and its absence a failure (`UNAVAILABLE`).

The database runs one transaction at a time, so the write budget alone would let
one person keep it busy with large versions (300 a minute at up to a second each).
After a save or restore that read 1 MiB or more, refused or not, that person waits
about a second per MiB before their next one of the same kind (`version_cooldown`;
a save and a restore are counted apart). A restore checks a given board name
before it hashes anything.

### Restore

1. The server reads the index row through `my_board_versions` **as the person**
   (no row: no access) and stages an empty first piece, which the module refuses
   unless the person may restore, so a viewer never makes the server download.
   It then fetches the object and checks its length and SHA-256 against the row.
2. It sends the text in pieces of at most 600,000 UTF-16 units (the database takes
   at most 2 MiB per call) with `stage_board_version_chunk`, **as the person**. Piece 0
   drops earlier pieces of the same request; pieces must arrive in order; the total
   cannot exceed the indexed size. The person's other restores (another tab) keep
   their pieces, up to two bundles in all, oldest dropped first.
3. `restore_board_version(id, requestKey, name)`, **as the person**, joins the pieces
   and, in one transaction: checks length and SHA-256 against the index again (so a
   person calling the database directly cannot restore forged content), parses and
   validates the bundle, creates the board, inserts every row with new ids, places it
   in the version's workspace with default access `none` and the restorer as its only
   manager, recounts its stats and records `requestKey` in `board_creation`. Any
   failure rolls everything back: no board, and the staged pieces stay for a retry.
   The same `requestKey` again returns the first board. When the answer is lost, the
   server looks the key up and reports the board, or `UNCONFIRMED`; the dashboard
   reuses a version's key until its restore succeeds, so a retry never makes a
   second board.

### Access, checked on every action

| Action | Who |
|---|---|
| Turn the plugin on or off | A signed-in workspace owner or admin |
| Save | A signed-in person with editor or manager access to the board, which must be in a workspace with the plugin on |
| List | Readers of the board, while it is still in the version's workspace; workspace owners and admins always |
| Restore | A signed-in full member (not a guest) with editor or manager access to the board; workspace owners and admins always (also for deleted or moved boards) |
| Publish | The dashboard server's service identity only |

Agents, workspace service accounts, link visitors and disabled accounts can do
none of these. The rules use the access people have now, so removing a member or
lowering a role takes effect on the next action. A restore lands in the
version's own workspace; other workspaces never see its versions.

### Board bundle format, version 1

```json
{"format":"draw.board-bundle","version":1,"sha256":"<hex>","board":{ … }}
```

- `sha256` is the SHA-256 of `JSON.stringify(board)`; a reader re-serializes the parsed
  `board` and compares. The index also keeps the SHA-256 of the whole file.
- `board` has exactly these keys: `name`, `source`, `architecture`, then one key per
  section below. Each row has exactly its listed columns. Unknown or missing keys
  are refused.
- Encoding: u64 ids as decimal strings; timestamps as microseconds since the Unix
  epoch, as a decimal string; identities as 64 lowercase hex characters; u32/i32/f32
  and booleans as JSON numbers and booleans; optional u64 as a string or `null`.
- `source`: `boardId`, `workspaceId`, `capturedAt`, `capturedBy`. Provenance only.
- `architecture`: `null`, or the board's `architecture_version` row
  (`assertionMode`, `status`, `historyId`, `index`, `ref`, `sha`, `baseBoardId`,
  `implementedBoardId`) and its history's `repository`. Provenance only.
- Rows are ordered by their original id. Size limit: 16 MiB (`MAX_BUNDLE_BYTES`).

Compatibility: never change v1. A schema change that a bundle must carry adds a
v2 and a decoder from v1 into it. A server refuses a bundle with a newer version
(`the bundle is format N; this server reads formats up to 1`).

A restore validates, before any write: size, JSON, format, version, checksum,
every field's type, unique ids and keys, and these relationships, which the live
board keeps by cascade: edge ends, edge weights and line hashes, charts on chart
nodes, icons, hide-set members and their sets, code ref targets, code-ref hashes,
change-note anchors and main refs, threat anchors. It does not re-run editorial
rules (grid, tokens, chart contracts): rows were valid when written, and older
rows may predate a rule, as undo already assumes.

### Table coverage inventory

In the bundle (`SECTIONS` in `module/src/board-bundle.ts`):

| Section | Table | Notes |
|---|---|---|
| `nodes` | `node` | All columns: geometry, kind, style, doc, hidden, imported, focal, `sourceKey`. |
| `edges` | `edge` | All columns but `evidenceSnippet` (code text). Ends remapped. |
| `edgeWeights` | `edge_weight` | |
| `edgeMotions` | `edge_motion` | |
| `edgeEvidenceHashes` | `edge_evidence_hash` | Line hashes stay, so citations can be re-checked. |
| `charts` | `chart` | Chart nodes only. |
| `nodeIcons` | `node_icon` | |
| `hideSets`, `hideSetMembers` | `hide_set`, `hide_set_member` | Hidden content and its named sets. |
| `repoFiles` | `repo_file` | |
| `codeRefs` | `code_ref` | All columns but `snippet` (code text). |
| `codeRefHashes` | `code_ref_hash` | |
| `changeNotes` | `change_note` | Review state kept. Reader ref ids remapped. |
| `threats` | `threat` | |
| `marks` | `mark` | Note, reply, status, author. A claim becomes `sent`; claim, lease and preferred agent are dropped. |
| `routeEvents`, `sessionRoute` | `route_event`, `session_route` | Waypoints remapped. |
| `session`, `sessionRemote` | `session`, `session_remote` | Checkpoint, coverage, remote, dirty paths. |
| `tracePlayback` | `trace_playback` | Span nodes remapped. |

Left out (`LEFT_OUT`; `scripts/verify-versions-local.mjs` fails on a published
table in neither list):

| Tables | Why |
|---|---|
| `board` | Its name is `board.name`. The restore makes a new board with a new id and link. |
| `architecture_version`, `architecture_history`, `history_workspace` | Provenance in `board.architecture`. A restored board joins no history and branches nothing. |
| `board_workspace`, `board_grant`, `team_grant`, `agent_grant`, `workspace_board_grant`, `workspace_team_grant`, `workspace_invite`, `public_board`, `guest_board`, `guest_claim_offer` | Authorization. A restore grants only the restorer. |
| `link_share`, `link_visit`, `chart_embed`, `chart_embed_visit`, `board_embed`, `board_embed_visit` | Share tokens. |
| `cursor`, `selection`, `open_board`, `mark_waiter` | Live presence. |
| `mark_read` | Each person's read position. |
| `node_touch` | Routes new marks to the agent that last edited a node: agent access. |
| `board_stats` | Derived; recomputed. |
| `activity_outbox` | Activity feed; the restored board starts its own. |
| `board_creation` | Creation receipts. |
| `code_consent` | Each person's setting. |
| Workspace, account, agent-link, service-account, library, limit and demo tables | Not board content. |
| `workspace_plugin`, `board_version`, `board_version_chunk`, `version_cooldown` | Plugin state. |

### References to other boards

- `architecture_version.baseBoardId`, `implementedBoardId` and `historyId` are kept
  in `board.architecture` and never re-linked. A restored branch cannot merge into
  its old base, and a restored import snapshot is an ordinary editable board.
  `sourceKey` and `relation` stay, so it can be branched again.
- `board_embed.comparisonBoardId` is share state and is left out.
- Board links inside text (node docs, labels, chart CSV) are kept as text. Opening
  them checks access then.
- Ids that only record history may name rows that no longer exist: a mark's node,
  route waypoints, route events, trace span nodes, removed change-note readers. A
  restore maps each one in the bundle to its new id and every other one to `0`, so
  no restored row points at another board's row.

### Privacy and code consent

Bundles never hold code text: `code_ref.snippet` and `edge.evidenceSnippet` are not
in the format. A version outlives the database row it copied, so a person who
later turns code storage off could not reach text kept in storage. Line hashes
are kept: the next checkpoint re-anchors refs and fills text where the board's
owner allows it. Threats, marks and docs are kept; anyone who can restore already
reads them on the board.

Storage credentials stay in the dashboard server's environment. Browsers see
object keys, never credentials or objects, and the API never names missing
settings (the server log does). Object keys contain workspace and board ids only.

### Assumptions

- The store accepts path-style requests (`<endpoint>/<bucket>/<key>`) signed with
  Signature Version 4, and returns 412 (or 409) to a conditional write on an
  existing key. A store that ignores `If-None-Match` still never overwrites in
  practice: each key is new. Its region is any string it accepts.
- The bucket is used only by this deployment. Its access keys, or the machine's
  role, can read and write objects there.
- Without keys the dashboard server signs with the machine's role
  (`machineCredentials` in `web/src/lib/server/object-store.ts`): the container
  credentials endpoint when `AWS_CONTAINER_CREDENTIALS_*` is set (an ECS task
  role), else the instance metadata service with IMDSv2 (an EC2 instance
  profile), with the role's session token, kept until five minutes before it
  expires. The self-host image lets the dashboard reach those two link-local
  addresses only in this mode (`docker/prod/workerd-entrypoint.sh`). EKS web
  identity token files are not read.
- The dashboard server holds the database's service token (`SPACETIMEDB_SERVICE_TOKEN`),
  as repository imports already require.
- Workspaces need sign-in, so Versions does too. A deployment without accounts has
  no workspaces and no Versions.
- A deleted board keeps its saved versions. Owners and admins of the
  version's workspace can still list and restore them.

### Limitations

- Nothing deletes versions or their objects. A save that fails after storing
  (the saver lost access in between, or the database did not answer) leaves an
  unlisted object and a `pending` row.
- A bundle holds at most 16 MiB. Larger boards are refused at save. For scale, a
  session board with 40,000 repository paths is about 3 MiB.
- Each save keeps one more object, and each restore one more board; only the write
  budget bounds how fast. A restore does not re-apply the per-board storage limits
  (`REDCRAYON_LIMITS`): a board saved before they were turned on restores above them,
  as its rows were stored before them.
- Many people saving large versions at once still share one database; the cooldown
  bounds each person, not everyone together.
- Restored code refs and citations have no code text until the next checkpoint.
- A restore lands in the version's workspace only.
- Staged pieces of an abandoned restore stay until that person's staged pieces pass
  two bundles' worth.
- Only path-style addressing.
- The dashboard panel is the only UI; the canvas has none.

### Verification

| Check | Command |
|---|---|
| Format, checksum, relationships, round trip | `pnpm -C module test` (`board-bundle.test.mjs`, `sha256.test.mjs`) |
| Real database: access, revocation, other workspaces, plugin off, consistency under concurrent writes, corrupt and oversized bundles, retries, large boards, table coverage | `scripts/stdb-test.sh run` (`verify-versions-local.mjs`) |
| Server: storage retries, overwrite refusal, chunking, lost answers, routes, UI | `pnpm -C web test` |
| End to end with a local S3-compatible store | `VERSIONS_S3_…=… scripts/stdb-test.sh versions` |
| Browser: turn on, save, restore, open, turn off | `VERSIONS_S3_…=… pnpm -C e2e test tests/board-versions.spec.ts` |
