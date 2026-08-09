# Keep builder and runner on one Alpine release: the copied Node binary shares its musl ABI.
FROM node:24-alpine3.23 AS builder

RUN corepack enable

WORKDIR /app

COPY pnpm-lock.yaml package.json ./

RUN pnpm install --frozen-lockfile

COPY src/ src/
COPY drizzle/ drizzle/
COPY tsconfig.json tsup.config.ts vite.config.ts ./

ARG GIT_COMMIT=unknown
ARG GIT_TAG=unknown
ARG BUILD_TIME=unknown

# tsup inlines build identity into the server bundle.
RUN GIT_COMMIT=$GIT_COMMIT GIT_TAG=$GIT_TAG BUILD_TIME=$BUILD_TIME pnpm build

FROM node:24-alpine3.23 AS deps

RUN corepack enable

WORKDIR /app

COPY pnpm-lock.yaml package.json ./

RUN pnpm install --prod --frozen-lockfile

# Alpine 3.23 supplies ffmpeg 8 for xHE-AAC/USAC; keep builder/deps aligned for musl.
FROM ghcr.io/linuxserver/baseimage-alpine:3.23 AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache ffmpeg

# Copy Node.js binary from builder (Alpine 3.23 does not ship Node 24 packages)
COPY --from=builder /usr/local/bin/node /usr/local/bin/node

COPY --from=deps /app/node_modules ./node_modules

COPY --from=builder /app/dist ./dist

# Migrations are loaded at runtime rather than bundled.
COPY --from=builder /app/drizzle ./drizzle

COPY pnpm-lock.yaml package.json ./

# Ship FFmpeg attribution and the project license with every image.
COPY THIRD_PARTY_NOTICES.md LICENSE ./

# Build gates presence; `docker/license-notice.test.ts` owns content validation.
RUN set -eu; \
    test -s /app/THIRD_PARTY_NOTICES.md; \
    test -s /app/LICENSE

COPY docker/root/ /

RUN mkdir -p /config /audiobooks /downloads

EXPOSE 3000

VOLUME ["/config", "/audiobooks", "/downloads"]

ENV CONFIG_PATH=/config
ENV DATABASE_URL=file:/config/narratorr.db

# `URL_BASE` keeps health probes valid behind a subpath proxy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:3000${URL_BASE:-}/api/health || exit 1
