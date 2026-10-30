# Build with: docker build -t redcrayon-import-runner importer
FROM golang:1.26-bookworm AS go
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=go /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}" PORT=8788
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate && pnpm install --prod --frozen-lockfile
COPY src ./src
USER node
EXPOSE 8788
CMD ["npm", "start"]
