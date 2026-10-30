<div align="center">

<img src="docs/hero/logo.svg" alt="" width="72"><br>

# draw

*by redcrayon*

**A live architecture board you and your coding agent draw on together.**<br>
The agent draws what it builds, with code refs to the exact lines. You read the board, not a prose summary.

[Docs](https://docs.redcrayon.ai/) · [Use cases](https://docs.redcrayon.ai/use-cases/build/) · [Connect](https://docs.redcrayon.ai/connect/) · [Self-host](https://docs.redcrayon.ai/self-host/quickstart/) · [Contributing](CONTRIBUTING.md)

<code>claude plugin marketplace add redcrayonai/draw && claude plugin install draw@redcrayonai</code>

<br><br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/hero/hero-dark.png">
  <img alt="A draw board: charts drawn beside the service they describe" src="docs/hero/hero-light.png" width="900">
</picture>

</div>

## Ask your agent in plain words

- *"Add rate limiting to the public API. Draw what you change on a redcrayon board."*
- *"Drop customers.name. Flag the migration and cite every reader of that column."*
- *"Checkout pods keep restarting since 14:00. Chart restarts and error rates on a scratch board."*
- *"Mark what this SIEM alert and scanner report affect, and tell me what to fix first."*

Every write, yours or the agent's, goes through the same rules. An invalid write
is refused with a sentence that says why.

## Install

Claude Code, with the plugin (server, `/draw:navigate`, code refs):

```sh
claude plugin marketplace add redcrayonai/draw && claude plugin install draw@redcrayonai
```

Run `/mcp` → draw → **Authenticate**, then `/draw:navigate`. Cursor,
Codex, claude.ai and other MCP clients use the server URL in
[Connect](https://docs.redcrayon.ai/connect/).

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
3. Connect your agent to `http://localhost:8788/mcp` ([plugin](#install))
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

For shared installations, see [workspaces, memberships, and self-hosted OIDC](docs/workspaces.md).

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

## More

- [docs/guide.md](docs/guide.md): what the canvas, agent tools and dashboard do, in full.
- [DESIGN.md](DESIGN.md): the interface's colors, typography, spacing and component rules.
- [CONTRIBUTING.md](CONTRIBUTING.md): the dev loop, bindings and module checks.

What the hosted service stores and how to delete it is in [docs/data-handling.md](docs/data-handling.md).

## License

The repository-wide license and copyright holder are pending.
The existing [plugin license](plugin/LICENSE) applies to the plugin.
