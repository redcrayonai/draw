# Self-hosting

Run the whole draw stack (canvas, dashboard, MCP server and database) on your
own machine. For a server with a domain and TLS, use `compose.prod.yml` and the
settings in [.env.example](.env.example). The docs site has the same steps:
[Self-host](https://docs.redcrayon.ai/self-host/quickstart/).

## Run it with Docker Compose

You need Docker with Compose and nothing else:

```sh
docker compose up --build
```

| | |
|---|---|
| canvas | http://localhost:5173 |
| dashboard | http://localhost:5174 |
| MCP server | http://localhost:8788/mcp |
| database | ws://localhost:3000, database `redcrayon-local` |

The stack also runs Postgres and the import runner. The first build takes a few
minutes. Ports 3000, 5173, 5174 and 8788 must be free; they listen on
127.0.0.1 only. Data stays in Docker volumes until `docker compose down -v`.
After a source change, run `docker compose up --build` again.

To have an agent draw on a board:

1. Open the canvas. It makes you a board.
2. Click **Share**, turn on **Share with link**, choose **Can edit**, and copy
   the link.
3. Connect your agent to `http://localhost:8788/mcp` ([plugin](README.md#install))
   and give it the link, for example `/draw:navigate <link>`. Its nodes
   appear on your board as it draws.

With no settings nobody signs in. The canvas and dashboard run as guests, and
the MCP server treats every caller on localhost as one dev user (`DEV_AUTH=1`),
so an agent needs no key. Keep it that way only on your own machine.
If a board your agent made shows as unavailable, open the dashboard link its
`start_session` returns, once, in the browser you use for the canvas, and press
"Link this agent to your dashboard".
If an older board has no creator history, linking keeps existing access and
reports that the database owner must recover its ownership before retrying.

### Real sign-in (optional)

Put these in a `.env` file next to `docker-compose.yml`, then run
`docker compose up --build`:

| Variable | Value |
|---|---|
| `VITE_AUTH_PROVIDER` | `oidc` |
| `VITE_OIDC_ISSUER` | your OpenID Connect issuer, exactly as the `iss` of its tokens |
| `VITE_OIDC_CLIENT_ID` | a public client at that issuer (authorization code with PKCE) |
| `OIDC_ISSUER` | the same issuer, byte for byte. The MCP server accepts the access tokens it issues for `http://localhost:8788/mcp` |
| `MCP_API_KEYS` | static agent keys, comma-separated `<sha256 hex of the key>:<user id>` pairs. The user id is your `sub` at the issuer, so the agent's boards are yours |

- Register `http://localhost:5173/` and `http://localhost:5174/` as the
  client's redirect URIs.
- With `OIDC_ISSUER` or `MCP_API_KEYS` set, `DEV_AUTH` is off. An agent then
  needs a key or a token from your issuer.

Make a key for your `sub` (the `sub` claim of your tokens at the issuer) and add it:

```sh
sub=YOUR_SUB
key="$(openssl rand -hex 32)"; echo "agent key: $key"
echo "MCP_API_KEYS=$(printf %s "$key" | openssl dgst -sha256 | awk '{print $NF}'):$sub" >>.env
```

Without an issuer any user id works: give the agent an edit link, as above.

The agent sends it as a bearer token, for example
`claude mcp add --transport http draw http://localhost:8788/mcp --header "Authorization: Bearer <key>"`.

For the plugin to use your local stack, start Claude Code with:

```sh
REDCRAYON_MCP_URL=http://localhost:8788/mcp claude
```

This sets the server and the code-ref helper to the same local endpoint.
Other MCP clients use the URL directly. For their code refs, run
`REDCRAYON_MCP_URL=http://localhost:8788/mcp npx -y @redcrayonai/draw@1 capture`.
