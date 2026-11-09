# syntax=docker/dockerfile:1.7
# The self-host images compose.prod.yml runs (RC-608), and the builder image that
# builds them. Build them all with docker-bake.hcl in this directory, from the
# repo root:
#
#   docker buildx bake -f docker/prod/docker-bake.hcl --load
#
# Targets: canvas, dashboard, mcp, module-setup, builder. The importer image is
# importer/Dockerfile. scripts/builder.mjs makes every build output once, on the
# build machine's platform (they are the same for every architecture); the
# per-architecture stages only add a binary and copy files, so amd64 + arm64
# builds stay fast. The images package the builder's outputs.
#
# Outside plugins (PLUGINS.md): a deployment passes its config directory (the
# plugins file and its lock, optional seams/) and, to build without a draw
# checkout, the published builder image:
#
#   docker buildx bake -f docker/prod/docker-bake.hcl \
#     --set '*.contexts.deploy=<config dir>' --set '*.contexts.seams=<config dir>/seams' \
#     --set '*.contexts.builder=docker-image://ghcr.io/redcrayonai/draw-builder:<version>' \
#     --secret id=git_credentials,src=<git credential-store file>
#
# Only the fetch stage sees the credentials; they never enter a layer or an output.
#
# VITE_* values are inlined at build, so the canvas and dashboard are built
# with placeholders (__rc_<name>__) that runtime-config.sh replaces with the
# container's VITE_* environment at start. VITE_AUTH_PROVIDER picks a module
# at build, so each of the two ships one build per provider (anonymous, oidc).

# workerd that wrangler 4.149.0 runs (mcp/pnpm-lock.yaml). Durable Object
# storage on local disk is experimental in workerd: change this pin only
# together with a backup of the mcp volume (docker/prod/README.md).
ARG WORKERD_VERSION=1.20261006.1
ARG SPACETIME_IMAGE=clockworklabs/spacetime:v2.8.1

FROM --platform=$BUILDPLATFORM ${SPACETIME_IMAGE} AS spacetime-native
FROM ${SPACETIME_IMAGE} AS spacetime

# ---- builder: draw's source, its installed packages and every build tool ----
# Published as draw-builder for the build platform only (docker-bake.hcl).
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
ENV WRANGLER_SEND_METRICS=false
# The disposable local database the builder checks schemas with.
COPY --from=spacetime-native /opt/spacetime/spacetimedb-cli /usr/local/bin/spacetime
COPY --from=spacetime-native /opt/spacetime/spacetimedb-standalone /usr/local/bin/spacetimedb-standalone
WORKDIR /draw
COPY module/package.json module/pnpm-lock.yaml module/
COPY shared/package.json shared/pnpm-lock.yaml shared/
COPY agent/package.json agent/pnpm-lock.yaml agent/
COPY agent/patches agent/patches
COPY mcp/package.json mcp/pnpm-lock.yaml mcp/
COPY client/package.json client/pnpm-lock.yaml client/
COPY web/package.json web/pnpm-lock.yaml web/
# No package runs an install script: a new dependency that wants one fails here.
RUN for p in module shared agent mcp client web; do pnpm --dir "$p" install --frozen-lockfile --config.strict-dep-builds=true || exit 1; done
COPY module module
COPY plugins plugins
COPY shared shared
COPY agent agent
COPY mcp mcp
COPY client client
COPY web web
COPY scripts scripts
COPY docker/prod docker/prod
ARG DRAW_VERSION=dev
RUN echo "$DRAW_VERSION" > VERSION && node scripts/builder.mjs baseline
ENTRYPOINT ["node", "/draw/scripts/builder.mjs"]

# ---- the build: fetch outside plugins (with credentials), then build (without) ----
# Empty unless a deployment passes them as named contexts.
FROM scratch AS deploy
FROM scratch AS seams

FROM builder AS fetch
RUN --mount=type=bind,from=deploy,target=/config \
    --mount=type=secret,id=git_credentials,required=false \
    --mount=type=ssh,required=false \
    --mount=type=cache,target=/cache/plugins \
    node /draw/scripts/builder.mjs fetch --config /config --into /fetched --cache /cache/plugins

FROM builder AS build
COPY --from=fetch /fetched /fetched
RUN --mount=type=bind,from=deploy,target=/config \
    --mount=type=bind,from=seams,target=/seams \
    node /draw/scripts/builder.mjs build --config /config --sources /fetched --seams /seams --out /out

# The workerd binary for the target architecture, from the same npm package
# wrangler installs (npm checks the registry's integrity hash).
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS workerd-bin
ARG TARGETARCH WORKERD_VERSION
WORKDIR /tmp/workerd
RUN case "$TARGETARCH" in amd64) arch=64 ;; arm64) arch=arm64 ;; *) echo "no workerd for $TARGETARCH" >&2; exit 1 ;; esac \
 && npm pack --silent "@cloudflare/workerd-linux-$arch@$WORKERD_VERSION" >/dev/null \
 && tar -xzf ./*.tgz && install package/bin/workerd /workerd

# The dbmate binary for the target architecture, at the version the dashboard installs.
FROM builder AS dbmate-bin
ARG TARGETARCH
RUN case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "no dbmate for $TARGETARCH" >&2; exit 1 ;; esac \
 && version="$(node -p 'require("/draw/web/node_modules/dbmate/package.json").version')" \
 && cd /tmp && npm pack --silent "@dbmate/linux-$arch@$version" >/dev/null \
 && tar -xzf ./*.tgz && install package/bin/dbmate /dbmate

# ---- canvas: static files behind Caddy ----
FROM caddy:2.11.7-alpine AS canvas
COPY --from=build /out/canvas /app/site
COPY --from=builder /draw/docker/prod/canvas.Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /draw/docker/prod/guard.sh /draw/docker/prod/runtime-config.sh /draw/docker/prod/canvas-entrypoint.sh /app/
# No privileges needed: port 8080, writes only under /tmp.
USER 65534
ENV XDG_DATA_HOME=/tmp/caddy-data XDG_CONFIG_HOME=/tmp/caddy-config
EXPOSE 8080
ENTRYPOINT ["/app/canvas-entrypoint.sh"]

# ---- dashboard and mcp: workerd ----
FROM debian:bookworm-slim AS workerd
COPY --from=workerd-bin /workerd /usr/local/bin/workerd
RUN mkdir /data && chown 10001:10001 /data
COPY --from=builder /draw/docker/prod/guard.sh /draw/docker/prod/runtime-config.sh /draw/docker/prod/workerd-entrypoint.sh /app/
USER 10001
WORKDIR /app

FROM workerd AS dashboard
COPY --from=build /out/dashboard /app/dashboard
# The config with the plugin setting bindings the build generated.
COPY --from=build /out/dashboard.capnp /app/
COPY --from=builder /draw/docker/prod/assets.js /app/
EXPOSE 5174
ENTRYPOINT ["/app/workerd-entrypoint.sh", "dashboard"]

FROM workerd AS mcp
COPY --from=build /out/mcp/worker.js /app/mcp/worker.js
COPY --from=builder /draw/docker/prod/mcp.capnp /draw/docker/prod/ratelimit.js /app/
# Durable Object storage (SQLite files): mount a volume on /data.
EXPOSE 8788
ENTRYPOINT ["/app/workerd-entrypoint.sh", "mcp"]

# ---- module-setup: one-shot publish (update only) and seed ----
FROM node:22-bookworm-slim AS module-setup
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=spacetime /opt/spacetime/spacetimedb-cli /usr/local/bin/spacetime
COPY --from=dbmate-bin /dbmate /usr/local/bin/dbmate
WORKDIR /app
# The module program: the module, its included plugin parts and shared/, without tests.
COPY --from=build /out/module-program/ /app/
COPY --from=builder /draw/web/db/migrations web/db/migrations
COPY --from=builder /draw/scripts/module-env.mjs /draw/scripts/publish-module.sh scripts/
COPY --from=builder /draw/docker/prod/guard.sh /draw/docker/prod/db-issuers.sh /draw/docker/prod/rollback.sh /draw/docker/prod/module-setup.sh docker/prod/
ENTRYPOINT ["/app/docker/prod/module-setup.sh"]
