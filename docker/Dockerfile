# The image docker-compose.yml runs everything but Postgres and the import
# runner from: Node, pnpm, the pinned SpacetimeDB CLI and server, and the
# packages the local stack needs, installed.
FROM node:22-bookworm

# Same pin as .github/actions/spacetime; bump the version and both checksums together.
ARG SPACETIME_VERSION=2.8.1
RUN case "$(dpkg --print-architecture)" in \
      amd64) triple=x86_64 sum=4ec3e769342035ec5bb1b8252d62536f66e430cf7c989c683d123a4e9c59f7b0 ;; \
      arm64) triple=aarch64 sum=d868b692bad756d8a1a0dcb329a7f6b74f3bfbf173d64e5a012ce1533f97709b ;; \
      *) echo "no SpacetimeDB build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
 && curl -sSfL -o /tmp/spacetime.tar.gz "https://github.com/clockworklabs/SpacetimeDB/releases/download/v${SPACETIME_VERSION}/spacetime-${triple}-unknown-linux-gnu.tar.gz" \
 && echo "${sum}  /tmp/spacetime.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/spacetime.tar.gz -C /tmp spacetimedb-cli spacetimedb-standalone \
 && install /tmp/spacetimedb-cli /usr/local/bin/spacetime \
 && install /tmp/spacetimedb-standalone /usr/local/bin/spacetimedb-standalone \
 && rm /tmp/spacetime.tar.gz /tmp/spacetimedb-cli /tmp/spacetimedb-standalone
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

WORKDIR /app
# Manifests first, so a source change does not reinstall.
COPY module/package.json module/pnpm-lock.yaml module/
COPY shared/package.json shared/pnpm-lock.yaml shared/
COPY mcp/package.json mcp/pnpm-lock.yaml mcp/
COPY client/package.json client/pnpm-lock.yaml client/
COPY web/package.json web/pnpm-lock.yaml web/
# mcp bundles agent/src
COPY agent/package.json agent/pnpm-lock.yaml agent/
COPY agent/patches agent/patches
RUN for p in module shared mcp client web agent; do pnpm --dir "$p" install --frozen-lockfile || exit 1; done
COPY . .
