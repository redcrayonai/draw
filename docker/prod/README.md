# Self-host images

`compose.prod.yml` (repo root) runs these images with `.env` (from `.env.example`).
This directory builds them.

| Image | What it runs |
| --- | --- |
| `redcrayon-canvas` | The canvas: static files behind Caddy on `:8080` |
| `redcrayon-dashboard` | The dashboard Worker on workerd, `:5174` |
| `redcrayon-mcp` | The agent server Worker on workerd, `:8788`; Durable Objects on `/data` |
| `redcrayon-module-setup` | One-shot: migrations, module publish (update only), service identities, seed |
| `redcrayon-importer` | The repository import runner (`importer/Dockerfile`) |

Build all of them for this machine (tags `ghcr.io/redcrayonai/redcrayon-*:dev`):

```sh
docker buildx bake -f docker/prod/docker-bake.hcl --load
```

`.github/workflows/release-images.yml` pushes them for amd64 and arm64 on a `v*`
tag. `.github/workflows/compose-prod-smoke.yml` builds them and runs the stack.

## Runtime settings

The canvas and dashboard bundles are built with placeholders (`__rc_<name>__`)
where `VITE_*` values go. At start, `runtime-config.sh` writes the container's
values over them, so one image serves any domain. `VITE_AUTH_PROVIDER` picks a
module at build time, so each image holds one build per provider (`anonymous`,
`oidc`) and starts the one you set.

Every entrypoint sources `guard.sh` and refuses to start with:

- `DEV_AUTH` set,
- `VITE_REQUIRE_AUTH=1` with `VITE_AUTH_PROVIDER=anonymous`, or `oidc` without
  `VITE_OIDC_ISSUER` and `VITE_OIDC_CLIENT_ID`,
- a secret (`POSTGRES_PASSWORD`, `IMPORT_RUNNER_SECRET`) that is empty, shorter
  than 16 characters or an example value, or an example entry in `MCP_API_KEYS`.

## workerd

The Workers run unchanged on workerd (RC-607). The hosted-only parts:

- **Rate limits**: `ratelimit.js`, same binding names and limits, a fixed window
  counted per container. One replica only; more need a shared counter.
- **Assets and the Cache API**: `assets.js` serves the dashboard's files with a
  Content-Type, and a no-op cache, without which every dashboard request fails.
- **The drain cron**: the `drain` service in `compose.prod.yml`.
- **Network**: each Worker may reach the networks its container is on (read from
  its routing table at start) and the public internet (the OIDC issuer), not
  loopback or other private ranges.
- **Host**: the mcp Worker answers only when the Host header is `MCP_ORIGIN`'s
  host. Caddy passes it through.

Durable Object storage on local disk is **experimental** in workerd. The
version is pinned (`WORKERD_VERSION` in the Dockerfile, the version wrangler
runs). Change the pin only with a fresh backup of `mcp-data`.

## Backups

Back up these named volumes (prefixed with the compose project name). Stop the
stack first (`docker compose -f compose.prod.yml stop`) for a consistent copy.

| Volume | Holds | If lost |
| --- | --- | --- |
| `stdb` | Boards and everything on them | All data |
| `stdb-cli` | The identity that owns the database | The module can never be published again |
| `pg` | Activity history | The dashboard's activity panel |
| `state` | The agent signing key, the dashboard's service token | Agents' tokens stop working; re-run setup |
| `mcp-data` | Usage counters, pending captures | Counters reset |
| `caddy-data` | Certificates | Caddy requests new ones |

For example, one volume to a tarball:

```sh
docker run --rm -v <project>_stdb:/v:ro -v "$PWD":/out alpine tar -czf /out/stdb.tgz -C /v .
```
