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
| Deployment | The operator | Server settings. A plugin is offered only when its `configured()` check passes and its canvas settings are set (`web/src/lib/server/plugins.ts`). | Unoffered plugins show greyed out and their API answers `UNAVAILABLE`. |
| Workspace | A workspace owner or admin | `workspace_plugin` row through `set_workspace_plugin` (`module/src/plugins.ts`). | Off by default. Off stops every action of the plugin in that workspace and keeps its data. |

Members see their workspaces' switches through the `my_workspace_plugins` view.
The dashboard lists offered plugins under **Settings › Plugins**.

To add a plugin:

1. Create `plugins/<id>/plugin.json` and the optional `module/`, `server/`, `web/`, and `client/` parts.
2. Use each part's public `@draw/*` interface and keep helpers inside that part.
3. Run `node scripts/plugin-build.mjs` to generate the registries and setting bindings.
4. Add manual environment forwarding, run the relevant checks, and enable the workspace switch.

The [plugin author guide](plugins/README.md) defines the manifest, interfaces,
mount points, generated files, and test commands.

### Design: plugins outside this repo

Status: direction agreed 2026-10-31. Steps 1–3 are built: the manifest,
generator, public interfaces, mounts, Versions migration, and the outside-plugin
builder (fetch, lock file, version ranges, `skip`/retire, type-level interface
check). Canvas parts (decision 5) are built too. Step 4, the template repository
and its documentation, remains. The rollback publish skip in decision 7 also exists.

Approved limits and departures:

- Board-owned plugin tables (`board: "part"`) wait until a plugin needs them.
  Current board-keyed tables must declare `board: "outlives"`.
- The generator writes Cap'n Proto setting bindings. In-repo plugins keep manual
  compose entries and `.env.example` lines; outside plugins use `plugins.env`.
  `role_networks` stays manual.
- The builder image is published for linux/amd64 only; its outputs are the same
  for every platform, and the images it builds are amd64 and arm64.
- New routes use `/api/plugins/<id>[/path]`. The old Versions POST routes remain
  forwarders for open clients. Open clients keep working across upgrades.

**Intent.** Plugins keep being built in this repo, in the open. Anyone may also
keep a plugin in a repo of their own, private or public: an operator with
features they do not want to open source, or something specific to how they use
draw; a company shipping a draw plugin next to its own product. Adding an
outside plugin should feel like a Go import: name its repository, build, done.
The open repo never names or knows an outside plugin.

**Goals.**

- One plugin shape. A plugin in this repo and a plugin in someone else's repo
  are built the same way; only where the code lives differs.
- Simple for plugin authors: one folder, one command to run draw with the
  plugin live, one command to build deployable images.
- A deployment is a fixed set of images: what runs is exactly what was built and
  tested, and rolling back means running the previous images.

**Non-goals.** Agent tools (MCP) in plugins (later, with a mount point of its
own); canvas features beyond the docked panel of decision 5; loading or downloading plugin code while draw runs;
a marketplace or registry; isolating plugins from draw (a plugin runs with the
same power as draw itself); hooks into board events; per-workspace plugin
settings beyond on and off; any particular plugin (an OKF export was an
example only).

**Anti-goals.** A plugin that breaks only in production; a deployment that changes
because a container restarted or a plugin repo moved; private plugin credentials
inside a running system or an image; an outside plugin that needs edits to this
repo.

**Decided.**

1. *Build time only.* Plugins are compiled in when images are built; nothing is
   fetched or compiled while draw runs. A deployment on a platform that cannot
   load code at run time must still work, and production images stay free of
   build tools.
2. *A plugins file* lists outside plugins, each a repository URL pinned to a tag
   or commit (as `go.mod`). For development an entry may name a local folder
   instead (as Go's `replace` / `go.work`). Plugins in this repo are always
   included and need no entry. A lock file committed next to it (as `go.sum`)
   records each plugin's exact commit and, when it has a database part, that
   part's schema. A build fails when a tag no longer points at its locked commit
   (tags can be moved), when a plugin's database part changes in a way the
   database would refuse (a removed or renamed column, compared with the locked
   schema as `scripts/check-module-upgrade.sh` compares the core with `main`),
   and a deploy build refuses local-folder entries.
3. *A builder image per draw release*, published with the other images
   (`ghcr.io/redcrayonai/draw-builder:<version>`): that release's source and
   every tool needed to run or build it.
   - Develop: a template gives a plugin repo `compose.yml` (the draw dev stack
     from the builder image, with the plugin folder mounted). `docker compose up`
     in the plugin folder runs draw with the plugin live: dashboard screens
     reload on edit; a database-part change republishes as a core change does.
   - Deploy: one command builds the deployment's whole set of images (canvas,
     dashboard, agent server, `module-setup`, importer), for example
     `docker buildx bake` with the template's bake file and the plugins file.
     A deployment can do the same from its own private repo.
   - Upgrade draw: change the builder version and rebuild. An incompatible
     plugin fails the build.
   - People changing draw and a plugin together keep using a clone of this repo
     with the plugin linked by local folder.
4. *The regular published images* include this repo's plugins. A self-hoster
   with no outside plugins never builds anything.
5. *A plugin can add, in the first version:* its own data (tables, actions and
   views in the board database), dashboard-server actions with their server
   settings, dashboard screens (its row on the Plugins page and its panels), and
   a canvas panel (`client/`, through `@draw/canvas`). Every part is optional: a
   plugin that saves nothing of its own (an export that reads what boards store)
   has no database part. Its only database row is the core's on/off switch per
   workspace.
   - *The canvas panel* is one mount point: the core shows a labeled button per
     plugin on the board's corner and one dock on the right, and owns the dock's
     frame, Close, Escape and width. The plugin fills the dock's body with
     `panel.mount(el, canvas)`. `canvas` gives the board (id, workspace, link),
     the selection and its changes, the person's token and the plugin's canvas
     settings; nothing that writes to the board. A board switch remounts the
     panel. Each panel renders inside an error boundary (decision 14).
   - *An agent* a plugin provides (`agent` in `client/index.ts`) gets no button
     or dock of its own: it joins the board's one chat panel, beside the agent
     the person runs. The core owns the panel; the plugin carries messages to
     its agent and the reply back.
   - *Canvas settings* (`canvasSettings` in the manifest) are public: the canvas
     ships their values to every browser. They are filled when the canvas
     container starts, from `<NAME>` or `plugins.env`, as the canvas's own runtime
     values are, and the dashboard offers the plugin only when they are set.
   - The workspace switch decides as everywhere: a canvas panel shows only on a
     workspace board whose workspace turned the plugin on, so never on a personal
     board or to a share-link guest.
6. *At run time nothing changes:* the deployment switch (a plugin is offered only
   when its server settings are complete) and the workspace switch (owners and
   admins; off by default; off keeps data) apply to every plugin.
7. *Rollback:* roll back the app images (dashboard, canvas, agent server); the
   database stays at its newer version, which accepts older apps because every
   database change stays compatible with older clients. So a plugin's database
   part only ever adds tables and columns. The database refuses to drop a table
   that holds data ("Cannot remove table …: table contains data") or any column
   ("Removing a column … requires a manual migration"), and drops an empty
   table quietly; both refusals leave the data and the running program as they
   were (tested 2026-10-31). So publishing an older database program after a
   newer one added a column, or a table that was used, fails, for the core as
   for plugins, and that used to keep the whole stack from starting.
   `module-setup` now skips the publish, and logs it, when
   these are the only refusals: its database program lacks columns or
   data-holding tables the live database has. The stack starts on the newer
   database. Rolling forward again finds the data where it was.
8. *Versions moves into this shape* as the first plugin built that way, still in
   this repo, to prove it.
9. *Stopping an outside plugin with a database part retires it; nothing is
   destroyed.* Its tables stay in the build for good, rebuilt from the schema
   in the lock file with none of the plugin's code (its data stays, unused); its
   screens and actions go. The build refuses a plugins
   file that drops a plugin the lock file says has a database part, unless the
   plugin is marked retired. Deleting a retired plugin's data is a manual,
   documented cleanup, never a build step. A plugin with no database part can
   be dropped from the plugins file at any time.
10. *A formal plugin contract, versioned with draw.* Plugins use a small,
   documented plugin interface, never draw's other code: the mount points for a
   plugin's data, server actions and screens, and the helpers a plugin may call.
   It follows draw's semantic versioning: a minor release may add to it; only a
   major release may change or remove anything. A plugin states the draw
   versions it works with, and a build outside that range fails. A build also
   fails if a plugin imports any of draw's code outside the interface, so the
   promise covers everything a plugin can reach. The interface
   starts as what Versions needs (Versions is then built only through it) and
   grows when a real plugin needs more. CI checks that a non-major change leaves
   it compatible, as `scripts/check-wire-compat.mjs` already does for public
   views.
11. *Plugin data about boards states what it is.* Each plugin table keyed by a
   board says whether it is *part of the board* (deleted with it, as every row
   about a board must be) or *outlives the board* (kept, as Versions keeps a
   deleted board's saved versions). The build refuses a board-keyed table that
   says neither; the core never guesses. `scripts/verify-deletion-local.mjs`
   will cover "part of the board" plugin tables when that support exists.
   In the first version, plugin data is not copied into versions or branches,
   and a restore or branch says which plugins' data it left out, never silently
   (copying it comes with a
   version 2 bundle format).
12. *Back up before changing plugins.* The docs tell operators to take a backup
   of the database and their settings (the plugins file, `.env`) before adding,
   upgrading, retiring or removing a plugin.
13. *The build generates the core's plugin lists.* Each plugin's manifest
   declares its id, its tables (and each board-keyed table's relationship to
   the board) and its server settings. From the manifests the build generates
   the module's plugin ids and export groups, the dashboard's plugin registry,
   the table classification in
   `module/src/board-bundle.ts`, and the setting bindings in
   `docker/prod/dashboard.capnp`. An outside plugin never edits this repo.
14. *No plugin author can block draw or a deployment.*
   - draw's releases: this repo's CI never builds outside plugins; it checks only
     that the plugin interface stays compatible. The contract promises the
     interface and nothing else, and the import check keeps plugins inside it. A
     breaking change to the interface ships in a major release, when the owner
     chooses.
   - An operator's upgrade: any plugin can be marked `skip` in the plugins file
     and the build leaves it out; skipping is explicit, never automatic. A
     skipped or retired plugin with a database part keeps its tables, rebuilt
     from the lock file's schema with none of its code, so nothing of the
     author's has to compile against the new draw.
   - At run time: a plugin action that fails fails only its own request, and
     each plugin screen renders inside an error boundary, so one broken panel
     shows an error instead of taking down the page. A slow plugin or one that
     writes where it should not cannot be contained (plugins run with draw's
     power): include an outside plugin only if you would trust it as you trust
     draw, like any dependency. Skipping it is the emergency exit.
15. *A build produces files; images are packaging.* The builder's output is the
   board database program, the dashboard and canvas builds and the agent
   server. A deployment with its own pipeline deploys those files itself and
   gives the build its seam modules (`$auth` provider,
   `redcrayon-worker-extra`) as inputs, so every deployment shares one build.
16. *Installs use pnpm, and no package or plugin runs a script.*
   - Every install in an image or the builder is `pnpm install --frozen-lockfile`
     at the version pinned in `packageManager`, never npm or yarn. The two
     `npm pack` calls in `docker/prod/Dockerfile` only download a registry
     tarball, which runs no scripts.
   - pnpm 10 runs no dependency's install scripts unless it is listed in
     `onlyBuiltDependencies`; this repo lists none (`esbuild`, `sharp` and
     `workerd` sit in `ignoredBuiltDependencies`). The builder will also set
     `strict-dep-builds`, so a new dependency that wants a script fails the
     install until someone lists it (pnpm 10.34.5 exits 1 with
     `ERR_PNPM_IGNORED_BUILDS`).
   - The builder fetches a plugin with git and compiles its code into draw's
     build. It never installs in a plugin's folder or runs a script from its
     `package.json`, and the manifest is data, not code. No plugin code runs in
     Node, in the fetch step, or with build secrets. To capture and check a
     plugin's tables, `lock` and `build` publish the module to a disposable
     local database, which runs it in its own sandbox, as production does.
     Plugin screens are not prerendered (the dashboard sets `prerender = false`).
   - In the first version a plugin uses only what draw already installs, plus
     its own code. Its own dependencies (a lockfile the builder installs,
     version clashes, the vendor scan) come later, through the same pnpm rules.

**Constraints from the codebase.**

- One board database program: a plugin's database part is compiled into the
  core module, so its table, reducer and view names share one namespace.
  Collisions must fail the build.
- Database changes are additive and keep older clients working (CLAUDE.md);
  the generated bindings follow the module.
- Every board table is classified in `module/src/board-bundle.ts` as bundle
  content or left out; a plugin's tables must be too, or Versions' coverage test
  fails.
- Dashboard server settings reach a self-hosted dashboard only when bound in
  `docker/prod/dashboard.capnp` and passed through the compose files.
- Text users or models read names no vendor; refusals start with `REJECTED`,
  `UNAVAILABLE` or `UNCONFIRMED`; source names no production host or account.
- Sign-in and deployment customizations use existing seams (`VITE_AUTH_PROVIDER` /
  `$auth`, `createWorker` deps, `redcrayon-worker-extra`); those stay. Plugins
  are the general route for features; the seams stay for sign-in and hosting.
- Private repositories are read with credentials given to the build only (build
  secrets), never written into an image.

### The builder

`node scripts/builder.mjs` (the `draw-builder` image runs the same file) builds
draw with outside plugins. The open repo never names one.

**Plugins file.** `draw-plugins.json` in a deployment's config directory:

```json
{
  "plugins": {
    "pinboard": { "repo": "https://example.com/acme/draw-pinboard.git", "ref": "v1.2.0" },
    "audit":    { "repo": "git@example.com:acme/draw-audit.git", "ref": "<40-hex commit>", "skip": true },
    "legacy":   { "retired": true },
    "scratch":  { "path": "../draw-scratch" }
  }
}
```

A key is the plugin id. `ref` is a tag or a full commit; branches and short
commits are refused. URLs carry no credentials. A `path` entry is for
development: deploy builds refuse it. The plugin repository root is the plugin
folder; only `plugin.json`, `module/`, `server/`, `web/` and `client/` are used,
without test files.

**Version range.** An outside plugin's `plugin.json` declares `"draw"`: caret
ranges such as `"^0.3.0"` or `"^0.3.0 || ^0.4.0"`, with npm semantics, so on 0.x
each minor release ends a range. Every build also type-checks plugin code
against this draw's interface.

**Lock file.** `draw-plugins.lock.json`, written only by `builder lock`, records
each plugin's exact commit, its manifest tables and, with a database part, its
schema as the database describes it (tables, indexes, public contracts).

| Refused | Where |
|---|---|
| A tag that now points at another commit | `lock`, `fetch`, `build`, `check-lock` |
| A plugin database change other than new tables, new indexes, or columns appended to private tables; a changed public table or view row | `lock` (rules, then the database itself), `check-lock` |
| A plugins file that drops a plugin with tables, unless it is `{ "retired": true }` | `lock`, `build` |
| A lock that differs from what its commits compile to | `build` |
| A plugin outside its draw range, or importing outside its interface | `lock`, `build` |

**Skip and retire.** `"skip": true` leaves a plugin out of a build, explicitly
and temporarily. `{ "retired": true }` leaves it out for good. Either way its
tables stay, rebuilt from the lock's schema with none of its code, and its data
and workspace switches stay. Deleting a retired plugin's data is a manual
cleanup. A plugin with no database part can simply be removed.

**Commands.**

| Command | Does |
|---|---|
| `lock [--config dir]` | Resolves new and changed entries, captures schemas, applies the upgrade rules, proves each plugin's tables can be rebuilt for a later skip or retirement. |
| `fetch --into dir` | Deploy-mode fetch, verified against the lock. The only step that reads credentials (a git credential-store file as the build secret `git_credentials`, or ssh). |
| `build --out dir [--sources dir] [--seams dir] [--dev]` | Compiles draw with the plugins in a scratch copy, type-checks the dashboard and the canvas with plugin code, and writes the module program, dashboard, canvas and agent server builds, `dashboard.capnp`, `canvas-settings`, `plugin-settings.env.example` and `build.json`. `--dev` allows `path` entries. |
| `check-lock --base file` | The lock must be a compatible upgrade of a base lock (for a deployment's CI). |
| `link` / `unlink` | In a clone, links `path` entries into `plugins/` for live development. Unlink before committing. |

`--seams` takes `auth.ts` (a third sign-in build, `custom`), `worker-extra.js`
(the dashboard's `redcrayon-worker-extra`) and `mcp-worker.ts` (the agent
server's entry). `docker/prod/Dockerfile` runs `fetch` and `build`; the images
package their outputs. The dashboard reads outside plugins' settings from
`plugins.env` next to the compose file; the canvas reads their canvas settings
from it too.

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

| Core (through the public interface) | Versions plugin |
|---|---|
| Bundle format, capture and restore: `module/src/board-bundle.ts` | Version index `board_version`, restore staging `board_version_chunk`: `plugins/versions/module/index.ts` |
| SHA-256 in the module: `module/src/sha256.ts` | Save, list and restore rules and actions |
| Workspace plugin switch: `module/src/plugins.ts` | Object storage and its settings: `plugins/versions/server/versions.ts` |
| Board access (`humanBoardRole`, workspace roles) | Dashboard UI and stores: `plugins/versions/web/`; the core mounts panels and owns `/workspaces/plugins` |
| | S3-compatible client: `plugins/versions/server/object-store.ts` |

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
   cannot exceed the indexed size, in at most 32 pieces. The person's other restores
   (another tab) keep their pieces, up to two bundles or 64 pieces in all, oldest
   dropped first.
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

### Board bundle format, version 2

```json
{"format":"draw.board-bundle","version":2,"sha256":"<hex>","board":{ … }}
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

Compatibility: never change a format. A schema change that a bundle must carry adds
the next version and a decoder from the older ones into it. Version 1 had no
`tellings` and decodes as version 2 with none. A server refuses a bundle with a
newer version (`the bundle is format N; this server reads formats up to 2`).

A restore validates, before any write: size, JSON, format, version, checksum,
every field's type, unique ids and keys, and these relationships, which the live
board keeps by cascade: edge ends, edge weights and line hashes, charts on chart
nodes, chart pins, icons, hide-set members and their sets, code ref targets, code-ref hashes,
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
| `chartAnchors` | `chart_anchor` | A chart's pin. Chart and target remapped. |
| `boardWindow` | `board_window` | The shared time window. |
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
| `tellings` | `telling` | Step nodes remapped; a node not in the bundle is dropped from its step. |

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
| `node_link` | A node's link to another board. The restored board is a new one; its nodes link no other board. |
| `board_stats` | Derived; recomputed. |
| `board_lifetime` | A restored board lasts, whatever the saved one was. |
| `incident` | Belongs to its live alert group. A restored copy must not catch that group's next notification. |
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
- `node_link.targetBoardId` (a node that links another board) is left out: the restored
  node is an ordinary node. Link it again from the canvas.
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
  (`machineCredentials` in `plugins/versions/server/object-store.ts`): the container
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
  two bundles' worth or 64 pieces.
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
