# CLAUDE.md

draw: a live architecture board that people and coding agents draw on together.
Agents connect over MCP; every write, human or agent, goes through the same
server-side rules in the database module.

## Layout

| Path | What it is |
|---|---|
| `module/` | Database module: tables, reducers, the board rules. The single source of truth |
| `client/` | Canvas (Vite) |
| `web/` | Dashboard (SvelteKit) |
| `mcp/` | MCP server Worker: tools, auth, live tap channel (`createWorker` in `mcp/src/app.ts`) |
| `agent/` | Session logic the MCP tools share: code refs, checkpoints, coverage |
| `shared/` | Code used by several packages (board links, identity, OIDC, capture) |
| `helper/` | The `redcrayon` CLI: capture, tap, marks |
| `importer/` | Codebase import and `fork-board` |
| `plugin/` | Claude Code plugin (`@redcrayonai/draw`): skill, hooks, MCP config |
| `e2e/` | Playwright browser journeys |
| `scripts/` | Repo checks, module test harness, release helpers |
| `docker/`, `docker-compose.yml`, `compose.prod.yml` | Self-host stack ([SELF_HOSTING.md](SELF_HOSTING.md)) |
| `docs/` | Docs site only. Do not add design specs, plans or decision records here |

Each package has its own `package.json` and lockfile; there is no workspace root.

## Commands

```sh
docker compose up --build                 # whole stack: canvas :5173, dashboard :5174, MCP :8788
pnpm -C <package> install --frozen-lockfile
pnpm -C <package> test                    # plus typecheck/build where the package has them
node --test scripts/*.test.mjs            # repo and workflow contracts
scripts/stdb-test.sh run                  # reducer integration suites on an isolated database
scripts/check-module-upgrade.sh           # schema must stay compatible with origin/main
node scripts/vendor-scan.mjs --public --enforce
```

## Rules

- **Schema changes are additive.** Append new columns at the end of a table,
  never in the middle; keep reducer arguments compatible with older clients.
  After a schema change regenerate the committed bindings (command in
  [CONTRIBUTING.md](CONTRIBUTING.md)) for `client agent importer web`.
- **Module first.** A release that changes the module publishes it before any
  Worker or client that reads the new shape.
- **Board links are `#b=<slug>` only**, built by `boardHref` in
  `shared/board-link.ts`. Never emit `?boardId=` (scripts/board-links.test.mjs).
- **No vendor names where users or models read.** Bundles, tool texts and error
  messages never name the database; refusals start with `REJECTED`,
  `UNAVAILABLE` or `UNCONFIRMED`. No auth-provider names, cloud account ids or
  production hostnames anywhere in source (vendor-scan fails CI).
- **The core stands alone.** Hosted-only code plugs in through seams
  (`VITE_AUTH_PROVIDER` / `$auth`, `createWorker` deps); never import or
  reference it from here.
- **Log events** are `area.event`, at most two levels, no service prefix
  (`tool.call`, `activity.drained`).
- Wrangler configs here are dev-only: local names, no routes, no account
  (scripts/ci-workflows.test.mjs).

## Pull requests

- **PR titles and commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):**
  `<type>(<optional scope>): <description>`, with `type` one of `feat`, `fix`,
  `docs`, `chore`, `refactor`, `perf`, `test`, `build`, `ci`; `!` or a
  `BREAKING CHANGE:` footer for breaking changes. Merges are squashed, so the PR
  title becomes the commit on `main`.
- `ci.yml` runs every check; `ci-ready` must pass.
- To release, label the PR `release:core`, `release:plugin` or `release:mcp`
  plus one of `major`, `minor`, `patch`; the merge tags it (`v*`, `plugin-v*`,
  `mcp-v*`).
