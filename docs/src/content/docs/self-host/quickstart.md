---
title: Quickstart
description: Run the whole draw stack on your machine with Docker Compose.
---

:::note
The compose stack ships with the open-source core, which is not in this
repository yet. These steps are for a checkout of the core.
:::

You need Docker with Compose and nothing else. From a checkout of the core:

```sh
docker compose up --build
```

| | |
|---|---|
| canvas | http://localhost:5173 |
| dashboard | http://localhost:5174 |
| MCP server | http://localhost:8788/mcp |
| SpacetimeDB | ws://localhost:3000 |

The board database is **SpacetimeDB**. The stack also runs the canvas, dashboard,
MCP server and repository import runner. The first build takes a few minutes.
Ports 3000, 5173, 5174 and 8788 must be free. They listen on 127.0.0.1 only. Data stays in Docker volumes until `docker compose down -v`.

:::note
The current core Compose files also include Postgres for dashboard activity
setup. That service is separate from SpacetimeDB board storage.
:::

## Have an agent draw

1. Open the canvas. It makes you a board.
2. Click **Share**, turn on **Share with link**, choose **Can edit**, and copy
   the link.
3. Connect your agent to `http://localhost:8788/mcp`
   ([Connect your agent](/connect/#your-own-server)) and give it the link, for
   example `/draw:navigate <link>`. Its nodes appear on your board as it
   draws.

:::caution
With no settings nobody signs in. The canvas and dashboard run as guests, and
the MCP server treats every caller on localhost as one dev user
(`DEV_AUTH=1`), so an agent needs no key. Keep it that way only on your own
machine.
:::

## Environment variables

For the local stack, put optional settings in a `.env` file beside
`docker-compose.yml`. No `.env` file is needed for guest drawing.
After a change, run `docker compose up --build` again.

### Settings you supply

| Variable | Default | Purpose |
|---|---|---|
| `VITE_AUTH_PROVIDER` | `anonymous` | Use `oidc` to enable account sign-in. |
| `VITE_OIDC_ISSUER` | Empty | Your OIDC issuer, exactly as the `iss` in its tokens. Required with `oidc`. |
| `VITE_OIDC_CLIENT_ID` | Empty | A public OIDC client with authorization code flow and PKCE. Required with `oidc`. |
| `OIDC_ISSUER` | Empty | The MCP server's sign-in issuer. Set it to the same value as `VITE_OIDC_ISSUER`. |
| `MCP_API_KEYS` | Empty | Optional static agent keys: comma-separated `<sha256 hex of the key>:<user id>` pairs. |

For an OIDC issuer, each agent key's user id is the person's `sub` at that issuer.
Keep keys and private tokens out of `VITE_*` settings. Those values are public
in the browser. Do not commit your `.env` file.

Example for sign-in:

```dotenv
VITE_AUTH_PROVIDER=oidc
VITE_OIDC_ISSUER=https://auth.example.com/realms/draw
VITE_OIDC_CLIENT_ID=draw-browser
OIDC_ISSUER=https://auth.example.com/realms/draw
```

The issuer must be reachable from your browser and the containers. Inside a
container, `localhost` refers to that container's network, not an external identity server.

### Settings Compose supplies

These values describe the supplied local stack. Compose fixes the connection
values or generates them during setup. Adding overrides to `.env` alone does
not change them. A custom topology needs matching Compose and application settings.

| Variable | Local value | Used by |
|---|---|---|
| `SPACETIME_DB` | `redcrayon-local` | Setup: the SpacetimeDB database name. |
| `VITE_SPACETIME_URI` | `ws://localhost:3000` | Canvas and dashboard browser connections. |
| `VITE_SPACETIME_DB` | `redcrayon-local` | Canvas and dashboard database selection. |
| `DB_URL` | `http://localhost:3000` | MCP server connection to SpacetimeDB. |
| `DB_NAME` | `redcrayon-local` | MCP server database selection. |
| `SPACETIMEDB_URL` | `http://localhost:3000` | Dashboard server connection. |
| `SPACETIMEDB_DB` | `redcrayon-local` | Dashboard server database selection. |
| `SPACETIMEDB_SERVICE_TOKEN` | Generated during setup | Private dashboard service credential. Keep it on the server. |
| `VITE_CANVAS_URL` | `http://localhost:5173` | Dashboard links to the canvas. |
| `VITE_DASHBOARD_URL` | `http://localhost:5174` | Canvas links to the dashboard. |
| `VITE_MCP_URL` | `http://localhost:8788/mcp` | Agent connection instructions in both apps. |
| `DEV_AUTH` | Automatic | The local MCP startup script enables it only while both `OIDC_ISSUER` and `MCP_API_KEYS` are empty. |

For the Claude Code plugin, `REDCRAYON_MCP_URL` selects your server. Set it in
the shell that starts Claude Code, not in the Compose `.env` file:

```sh
REDCRAYON_MCP_URL=http://localhost:8788/mcp claude
```

This reference covers `docker-compose.yml`. The prebuilt production stack uses
`compose.prod.yml` and the core checkout's `.env.example`, with additional domain,
version and secret settings.

## Real sign-in

After you set the OIDC values above:

- Register `http://localhost:5173/` and `http://localhost:5174/` as the
  client's redirect URIs.
- With `OIDC_ISSUER` or `MCP_API_KEYS` set, `DEV_AUTH` is off. An agent then
  needs a key or a token from your issuer.

Make a key for your `sub` and add it:

```sh
sub=YOUR_SUB
key="$(openssl rand -hex 32)"; echo "agent key: $key"
echo "MCP_API_KEYS=$(printf %s "$key" | openssl dgst -sha256 | awk '{print $NF}'):$sub" >>.env
```

Without an issuer any user id works: give the agent an edit link, as above.

The agent sends the key as a bearer token:

```sh
claude mcp add --transport http draw http://localhost:8788/mcp --header "Authorization: Bearer <key>"
```

## Code storage and team access

Code snippet storage starts off on your own stack too. Enable it under dashboard
**Settings → Code** only if you want inline snippets. Cited files still pass
through your server for checks. See [Data and consent](/data-and-consent/).

With real sign-in configured, open dashboard **Workspaces** to create a workspace
and invite collaborators. Board and workspace grants control access independently
of snippet consent. See [Workspaces and access](/capabilities/workspaces/).

## Next

Production images, with TLS and real hostnames, are coming to these docs.
