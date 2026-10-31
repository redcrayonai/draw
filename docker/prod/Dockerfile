# syntax=docker/dockerfile:1.7
# The self-host images compose.prod.yml runs (RC-608). Build them all with
# docker-bake.hcl in this directory, from the repo root:
#
#   docker buildx bake -f docker/prod/docker-bake.hcl --load
#
# Targets: canvas, dashboard, mcp, module-setup. The importer image is
# importer/Dockerfile. The JavaScript builds run once on the build machine's
# platform (they are the same for every architecture); the per-architecture
# stages only add a binary and copy files, so amd64 + arm64 builds stay fast.
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

FROM ${SPACETIME_IMAGE} AS spacetime

# ---- shared build stage (build platform) ----
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS deps
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
ENV WRANGLER_SEND_METRICS=false
WORKDIR /src
COPY module/package.json module/pnpm-lock.yaml module/
COPY shared/package.json shared/pnpm-lock.yaml shared/
COPY agent/package.json agent/pnpm-lock.yaml agent/
COPY agent/patches agent/patches
COPY mcp/package.json mcp/pnpm-lock.yaml mcp/
COPY client/package.json client/pnpm-lock.yaml client/
COPY web/package.json web/pnpm-lock.yaml web/
RUN for p in module shared agent mcp client web; do pnpm --dir "$p" install --frozen-lockfile || exit 1; done
COPY module module
COPY shared shared
COPY agent agent
COPY mcp mcp
COPY client client
COPY web web

# Fails the build when a placeholder did not survive into the output (a
# minifier folded it away), since runtime-config.sh could not set it then.
COPY docker/prod/check-placeholders.sh /usr/local/bin/

FROM deps AS canvas-build
ENV VITE_SPACETIME_URI=__rc_spacetime_uri__ VITE_SPACETIME_DB=__rc_spacetime_db__ \
    VITE_DASHBOARD_URL=__rc_dashboard_url__ VITE_MCP_URL=__rc_mcp_url__
WORKDIR /src/client
RUN VITE_AUTH_PROVIDER=anonymous pnpm exec vite build --outDir /out/anonymous \
 && VITE_AUTH_PROVIDER=oidc VITE_OIDC_ISSUER=__rc_oidc_issuer__ VITE_OIDC_CLIENT_ID=__rc_oidc_client_id__ \
    VITE_REQUIRE_AUTH=__rc_require_auth__ pnpm exec vite build --outDir /out/oidc \
 && check-placeholders.sh /out/anonymous spacetime_uri spacetime_db dashboard_url mcp_url \
 && check-placeholders.sh /out/oidc spacetime_uri spacetime_db dashboard_url mcp_url oidc_issuer oidc_client_id require_auth

FROM deps AS dashboard-build
ENV VITE_SPACETIME_URI=__rc_spacetime_uri__ VITE_SPACETIME_DB=__rc_spacetime_db__ \
    VITE_CANVAS_URL=__rc_canvas_url__ VITE_MCP_URL=__rc_mcp_url__
WORKDIR /src/web
# The adapter's output plus wrangler's bundle of worker.js; workerd serves the
# assets through assets.js, so the adapter's own worker and _headers go.
RUN for p in anonymous oidc; do \
      if [ "$p" = oidc ]; then export VITE_OIDC_ISSUER=__rc_oidc_issuer__ VITE_OIDC_CLIENT_ID=__rc_oidc_client_id__; fi; \
      VITE_AUTH_PROVIDER=$p pnpm exec vite build >/dev/null \
      && pnpm exec wrangler deploy --dry-run --env '' --outdir "/out/$p" >/dev/null \
      && cp -R .svelte-kit/cloudflare "/out/$p/assets" \
      && rm -f "/out/$p/assets/_worker.js" "/out/$p/assets/_headers" "/out/$p"/*.map "/out/$p/README.md" \
      && sed -i '/^\/\/# sourceMappingURL=/d' "/out/$p/worker.js" \
      || exit 1; \
    done \
 && check-placeholders.sh /out/anonymous spacetime_uri spacetime_db canvas_url mcp_url \
 && check-placeholders.sh /out/oidc spacetime_uri spacetime_db canvas_url mcp_url oidc_issuer oidc_client_id

FROM deps AS mcp-build
WORKDIR /src/mcp
RUN pnpm exec wrangler deploy --dry-run --env '' --outdir /out >/dev/null \
 && rm -f /out/*.map /out/README.md

# The workerd binary for the target architecture, from the same npm package
# wrangler installs (npm checks the registry's integrity hash).
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS workerd-bin
ARG TARGETARCH WORKERD_VERSION
WORKDIR /tmp/workerd
RUN case "$TARGETARCH" in amd64) arch=64 ;; arm64) arch=arm64 ;; *) echo "no workerd for $TARGETARCH" >&2; exit 1 ;; esac \
 && npm pack --silent "@cloudflare/workerd-linux-$arch@$WORKERD_VERSION" >/dev/null \
 && tar -xzf ./*.tgz && install package/bin/workerd /workerd

# The module's runtime dependencies for module-setup: pure JavaScript, plus the
# dbmate binary for the target architecture.
FROM deps AS setup-deps
ARG TARGETARCH
RUN case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "no dbmate for $TARGETARCH" >&2; exit 1 ;; esac \
 && version="$(node -p 'require("/src/web/node_modules/dbmate/package.json").version')" \
 && cd /tmp && npm pack --silent "@dbmate/linux-$arch@$version" >/dev/null \
 && tar -xzf ./*.tgz && install package/bin/dbmate /dbmate \
 && find /src/module/src /src/shared -maxdepth 1 -name '*.test.*' -delete

# ---- canvas: static files behind Caddy ----
FROM caddy:2.11.7-alpine AS canvas
COPY --from=canvas-build /out /app/site
COPY docker/prod/canvas.Caddyfile /etc/caddy/Caddyfile
COPY docker/prod/guard.sh docker/prod/runtime-config.sh docker/prod/canvas-entrypoint.sh /app/
# No privileges needed: port 8080, writes only under /tmp.
USER 65534
ENV XDG_DATA_HOME=/tmp/caddy-data XDG_CONFIG_HOME=/tmp/caddy-config
EXPOSE 8080
ENTRYPOINT ["/app/canvas-entrypoint.sh"]

# ---- dashboard and mcp: workerd ----
FROM debian:bookworm-slim AS workerd
COPY --from=workerd-bin /workerd /usr/local/bin/workerd
RUN mkdir /data && chown 10001:10001 /data
COPY docker/prod/guard.sh docker/prod/runtime-config.sh docker/prod/workerd-entrypoint.sh /app/
USER 10001
WORKDIR /app

FROM workerd AS dashboard
COPY --from=dashboard-build /out /app/dashboard
COPY docker/prod/dashboard.capnp docker/prod/assets.js /app/
EXPOSE 5174
ENTRYPOINT ["/app/workerd-entrypoint.sh", "dashboard"]

FROM workerd AS mcp
COPY --from=mcp-build /out/worker.js /app/mcp/worker.js
COPY docker/prod/mcp.capnp docker/prod/ratelimit.js /app/
# Durable Object storage (SQLite files): mount a volume on /data.
EXPOSE 8788
ENTRYPOINT ["/app/workerd-entrypoint.sh", "mcp"]

# ---- module-setup: one-shot publish (update only) and seed ----
FROM node:22-bookworm-slim AS module-setup
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=spacetime /opt/spacetime/spacetimedb-cli /usr/local/bin/spacetime
COPY --from=setup-deps /dbmate /usr/local/bin/dbmate
WORKDIR /app
COPY --from=setup-deps /src/module module
COPY --from=setup-deps /src/shared shared
COPY web/db/migrations web/db/migrations
COPY scripts/module-env.mjs scripts/publish-module.sh scripts/
COPY docker/prod/guard.sh docker/prod/db-issuers.sh docker/prod/module-setup.sh docker/prod/
ENTRYPOINT ["/app/docker/prod/module-setup.sh"]
