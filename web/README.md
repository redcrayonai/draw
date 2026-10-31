# redcrayon dashboard

The dashboard lists boards and provides profile, settings, and agent-link pages.
It uses SvelteKit pages and server routes. The canvas lives in `client/`.

Run the complete local stack with [Docker Compose](../SELF_HOSTING.md#run-it-with-docker-compose).
The dashboard opens at `http://localhost:5174`.
Compose supplies Postgres, the import runner, and the local service identity.

## Configuration

Compose sets the database and application origins for the local stack.
Optional OIDC sign-in uses the variables in the
[self-hosting guide](../SELF_HOSTING.md#real-sign-in-optional).

| Variable | Purpose |
| --- | --- |
| `VITE_SPACETIME_URI`, `VITE_SPACETIME_DB` | Database connection for the browser |
| `VITE_CANVAS_URL` | Origin for canvas links |
| `VITE_MCP_URL` | HTTP MCP endpoint |
| `VITE_AUTH_PROVIDER` | `anonymous`, `oidc`, or an adapter implementing `shared/browser-auth.ts` |
| `VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID` | OIDC issuer and public PKCE client |
| `DATABASE_URL` | Server-only Postgres connection for activity |
| `SPACETIMEDB_URL`, `SPACETIMEDB_DB`, `SPACETIMEDB_SERVICE_TOKEN` | Server database connection and registered service identity |
| `IMPORT_RUNNER_URL`, `IMPORT_RUNNER_SECRET`, `IMPORT_CALLBACK_URL` | Local import requests and callbacks |

Browser variables are public in the built assets.
Service credentials have no `VITE_` prefix and stay on the server.
The local Compose stack uses loopback ports and anonymous imports.

## Data and access

Boards come from the caller-scoped `my_boards` view in SpacetimeDB.
The module checks board permissions and provides private content through
caller-scoped views. A board locator alone grants no access.

Postgres stores activity and metric history. The dashboard drains the private
database outbox into `activity_event` before it returns activity.
Repeated actions within 60 seconds appear as one activity row with a count.

Agent links and explicit board grants determine agent access.
Linking an agent does not grant access to every board owned by its person.

## Contributor checks

```sh
pnpm -C web test
pnpm -C web check
pnpm -C web build
```

Route tests use Postgres when `DATABASE_URL` is set.
See [CONTRIBUTING.md](../CONTRIBUTING.md) for dependencies and module checks.

## Layout

- `src/routes/`: dashboard, profile, settings, link, and server API routes
- `src/lib/stdb.ts`: database subscriptions
- `src/lib/auth.ts` and `src/lib/session.ts`: auth and browser session state
- `src/lib/server/`: activity, imports, bearer checks, and database connections
- `src/lib/components/`: dashboard components
- `src/lib/theme.ts` and `src/lib/styles/`: themes and design tokens
- `src/module_bindings/`: committed generated database bindings
- `db/migrations/`: Postgres migrations
