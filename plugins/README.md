# Author a draw plugin

Plugins add optional features to draw. The deployment offers a plugin when its
server settings are complete. A workspace owner or admin turns it on for that
workspace. Off keeps the data. [PLUGINS.md](../PLUGINS.md) records the design and
future work. [Versions](versions/) is the working example.

Plugins run with draw's full privileges. There is no sandbox. Include only code
that you trust as much as draw itself. Use dependencies that draw already
installs, plus the plugin's own code. Custom dependency installs and install
scripts are not supported.

## Folder and manifest

Create one folder under `plugins/`:

```text
plugins/example/
  plugin.json
  module/index.ts  # optional database part
  server/index.ts  # optional dashboard server part
  web/index.ts     # optional dashboard UI part
  client/index.ts  # optional canvas part
```

Every part is optional. Every part folder that exists must contain `index.ts`.
Keep each part's helpers inside that part.

```json
{
  "id": "example",
  "name": "Example",
  "description": "An optional board feature.",
  "settings": ["EXAMPLE_ENDPOINT"],
  "canvasSettings": ["EXAMPLE_PANEL_URL"],
  "tables": {
    "exampleRecord": { "why": "the example index", "board": "outlives" }
  }
}
```

The manifest accepts only these fields:

| Field | Rules |
|---|---|
| `id` | Required. Matches its folder and `/^[a-z][a-z0-9]{1,30}$/`. |
| `name` | Required string, 1–40 characters. |
| `description` | Required string, 1–200 characters. |
| `draw` | Optional here; required for a plugin outside this repo. Caret ranges of draw versions it supports, such as `"^0.3.0"` or `"^0.3.0 \|\| ^0.4.0"`. |
| `settings` | Optional array, defaults to `[]`. Each name matches `/^[A-Z][A-Z0-9_]*$/`. Names are unique within and across plugins. |
| `canvasSettings` | Optional array, defaults to `[]`. Values the canvas part reads; **public**, the canvas sends them to every browser. Same name rules, unique with `settings` too, and none of the canvas's own settings (`SPACETIME_URI`, `MCP_URL`, …). |
| `tables` | Optional object, defaults to `{}`. Each key matches `/^[a-z][A-Za-z0-9]*$/` and is unique across plugins. |
| `tables.<key>.why` | Required string, 1–80 characters. Explains why the bundle leaves this table out. |
| `tables.<key>.board` | Optional. The only accepted value is `"outlives"`. |

Table keys are TypeScript schema names, such as `exampleRecord`, not SQL names.
Declare every plugin table in the manifest. A table with a published `board_id`
column must declare `"board": "outlives"`. Its data survives board deletion and
stays out of saved versions and branches. Tables that form part of a board
(`"board": "part"`) are deferred until a plugin needs them.

## Public interfaces and imports

Each part has one public alias. The linked files define the exact exports.

| Part | Alias | Exports |
|---|---|---|
| `module/` | `@draw/module` | [module/src/plugin-api.ts](../module/src/plugin-api.ts): schema primitives, bundle helpers, hashes, workspace access, plugin switch, `ModuleApi`, `ModulePart`. |
| `server/` | `@draw/server` | [web/src/lib/server/plugin-api.ts](../web/src/lib/server/plugin-api.ts): environment, HTTP responses, database calls, logs, `PluginRequest`, `ServerPart`. |
| `web/` | `@draw/client` | [web/src/lib/plugin-api.ts](../web/src/lib/plugin-api.ts): stores, links, session token, `Button`, connection and version types, `BoardPanelProps`, `WebPart`. |
| `client/` | `@draw/canvas` | [client/src/plugin-api.ts](../client/src/plugin-api.ts): `Canvas`, `CanvasBoard`, `CanvasNode`, `CanvasPanel`, `CanvasPart`. Types only. |

Non-test code imports only its own alias or relative files within its own part.
This rule also covers re-exports, `require()`, and dynamic imports. Import paths
must be literal strings. Imports cannot reach another part, core files, another
plugin, or bare dependencies. Symlinks cannot bypass this boundary. Files named
`*.test.*` are exempt so tests can use their runner and fixtures.
JSX and TSX source files are not supported; use JavaScript, TypeScript, or Svelte.

## Database part

Export `tables` from `module/index.ts`. Export `features(db, api)` for reducers,
procedures, and views. The core merges the tables into its schema, then calls
`features` with that schema and the `ModuleApi` helpers. Return the feature
exports as an object. [Versions' module part](versions/module/index.ts) shows
this shape.

Call `pluginEnabled(ctx, workspaceId, id)` in every action and view. Enforce the
caller's access rules there too. A hidden panel or an unavailable server does
not prevent direct database calls.

Tables, reducers, and views share the core's namespace. Choose names that avoid
collisions with core and other plugins. Database changes stay additive and
compatible with older clients. Regenerate the committed bindings after schema
changes, as described in [CONTRIBUTING.md](../CONTRIBUTING.md#package-checks).

## Dashboard server part

Export `configured(): boolean` to report deployment availability. Without this
export, the plugin is available by default. A thrown error makes it unavailable.
Export `handle(event): Promise<Response>` for requests. The event contains
`request`, `url`, and `path: string[]`.

The dispatcher sends `/api/plugins/<id>` and `/api/plugins/<id>/<path>` to
`handle`. An unknown plugin or missing handler returns 404. An unavailable
plugin returns 503. A failed request stays within that request. The handler
owns method dispatch, input checks, authentication, and its error responses.

Versions uses `POST /api/plugins/versions` and
`POST /api/plugins/versions/<versionId>/restore`. The old `POST /api/versions`
and `POST /api/versions/<versionId>/restore` remain as forwarders for open
clients.

The generator writes manifest settings into the marked section of
[docker/prod/dashboard.capnp](../docker/prod/dashboard.capnp). Do not edit that
section by hand. A setting must not reuse a binding outside the generated
section in `dashboard.capnp`. Plugins in this repo add their environment
forwarding to [compose.prod.yml](../compose.prod.yml),
[docker-compose.yml](../docker-compose.yml) and [.env.example](../.env.example).
Plugins outside this repo need no entries: the dashboard reads `plugins.env`.
Network access through `role_networks` remains manual.

## Dashboard UI part

Export any of these from `web/index.ts`:

- `BoardPanel`: a Svelte component with `boardId: bigint`, `workspaceId: bigint`,
  `canEdit: boolean`, and `disabled: boolean` props.
- `attach(conn, stale)`: attach subscriptions after a database connection opens.
  When `stale()` is true, ignore callbacks.
- `reset()`: clear plugin state when the dashboard resets its connection.

The core mounts each panel on native board cards with workspace permissions.
The panel owns its offered/enabled state and respects `canEdit` and `disabled`.
Use local stores for state. Clear them in `reset`. Each panel has an error
boundary. An `attach` or `reset` error does not stop other plugins. These
boundaries do not contain slow code or prevent privileged writes.

## Canvas part

Export `panel` from `client/index.ts`:

```ts
import type { CanvasPanel } from '@draw/canvas';

export const panel: CanvasPanel = {
  label: 'Example',           // the launcher button's text and the panel's title
  mount(el, canvas) {         // fills el on the first open
    const off = canvas.onSelectionChange(() => { /* canvas.selectedNodes() */ });
    return () => off();       // cleanup: on a board switch, or when the plugin turns off
  },
};
```

The canvas has one mount point. A labeled button per plugin sits on the board's
corner and opens one dock on the right. The core owns the button and the dock's
frame: its title, Close, Escape, the resize edge and the remembered width.
`mount` fills only the dock's body. Closing hides the panel and keeps it
mounted; on open the core focuses the first `[autofocus]` element in it.

`canvas` holds:

- `board`: `id`, `workspaceId`, and `link`, the address bar's link. On a
  share-link visit the link carries the share token: treat it as a secret.
- `selectedNodes()` and `onSelectionChange(listener)`.
- `token()`: the person's bearer token for the board database, or null.
- `settings`: the manifest's `canvasSettings`, each `''` when unset.

The panel shows only on a workspace board whose workspace turned the plugin on,
with every canvas setting set. Personal boards and share-link guests never see
it. The canvas has no helpers that write to the board: a plugin writes through
its own database or server part.

Each panel has an error boundary. An error thrown by `mount` or by a selection
listener replaces that panel with an error card and leaves the board and other
panels working; one thrown by the cleanup is logged. Errors in the panel's own
event handlers reach the browser console and touch nothing else.

Style the panel with a CSS file imported from the part (`import './panel.css'`)
and draw's theme variables (`--ink`, `--muted`, `--panel`, `--panel-2`,
`--panel-hi`, `--border`, `--hairline`, `--sel`, `--sans`, `--space-*`,
`--r-*`), so it follows every theme. Prefix class names with the plugin id.

Canvas settings reach the canvas as `VITE_<NAME>`. In development, set them in
`client/.env`. A deployment sets `<NAME>`, or puts it in `plugins.env`: the
canvas container fills it in when it starts, and the dashboard reads the same
value to decide whether to offer the plugin. Values may hold URL characters only.

## Generate and check

After a manifest change, run the generator from the repository root:

```sh
node scripts/plugin-build.mjs
node scripts/plugin-build.mjs --check
node scripts/plugin-build.mjs --check --api
node scripts/plugin-build.mjs --api-types module   # after pnpm -C module install
node scripts/plugin-build.mjs --api-types web      # after pnpm -C web and -C shared install
node scripts/plugin-build.mjs --api-types client   # after pnpm -C client install
```

The first command checks manifests and imports, then writes the registries and
setting bindings. `--check` refuses stale generated files without writing.
`--api` also compares public export names with `origin/main`. `--api-types`
compares the interface's types with `origin/main`: every value must still fit
its old uses, types draw hands to plugins may only grow, and the types plugins
hand to draw (`ModulePart`, `ServerPart`, `WebPart`, `CanvasPart`) must still accept what
plugins wrote for the old ones. CI runs all three. A breaking change needs a
breaking core release: a PR labelled `release:core` with `minor` while draw is
0.x, or `major` from 1.0 on, sets `PLUGIN_API_MAJOR=true` and the checks report
without failing.

Do not hand-edit `module/src/plugin-meta.generated.ts`,
`module/src/plugin-parts.generated.ts`, `web/src/lib/server/plugins.generated.ts`,
`web/src/lib/plugins.generated.ts`, `client/src/plugins.generated.ts`, or the
generated Cap'n Proto section.

## Tests

Run checks for the parts that changed:

```sh
node --test scripts/plugin-build.test.mjs
pnpm -C module test
pnpm -C web test
pnpm -C client test
scripts/stdb-test.sh run
```

The web runner discovers `../plugins/*/{server,web}/**/*.test.ts`; the canvas
runner discovers `../plugins/*/client/**/*.test.ts`. The module
unit runner still discovers only `module/src/*.test.mjs`. It does not discover
plugin module tests automatically. Add database integration checks to the
existing harness for new database behavior.

`scripts/verify-versions-local.mjs` checks real database rules and published
table coverage. It also checks `board_id` declarations against manifest
metadata. Versions additionally has these store and browser checks:

```sh
# Requires a local object store and the VERSIONS_S3_* environment settings.
scripts/stdb-test.sh versions
pnpm -C e2e test tests/board-versions.spec.ts
```

## Plugins outside this repo

The same folder can live in a repository of its own, with `plugin.json` at its
root and a `draw` range. Deployments name it in `draw-plugins.json` and build
with `node scripts/builder.mjs` or the `draw-builder` image; see
[PLUGINS.md](../PLUGINS.md#the-builder). To change draw and a plugin together,
list the plugin's folder as a `path` entry in a clone and run
`node scripts/builder.mjs link` (`unlink` before committing).
`scripts/fixtures/outside-plugin/` is the builder's test plugin. A template
repository comes later.
