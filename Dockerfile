# Build stage
# Pinned to alpine3.23 to match the runner base (baseimage-alpine:3.23): the runner
# copies this stage's musl-linked node binary, so both must share an Alpine release
# to avoid a musl/loader ABI mismatch (#1667).
FROM node:24-alpine3.23 AS builder

# Enable corepack for pnpm
RUN corepack enable

WORKDIR /app

# Copy package files
COPY pnpm-lock.yaml package.json ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code, configs, and migration files
COPY src/ src/
COPY drizzle/ drizzle/
COPY tsconfig.json tsup.config.ts vite.config.ts ./

# Accept git commit SHA and build timestamp as build args
ARG GIT_COMMIT=unknown
ARG GIT_TAG=unknown
ARG BUILD_TIME=unknown

# Build application — GIT_COMMIT, GIT_TAG, and BUILD_TIME are inlined into the server bundle by tsup esbuildOptions
RUN GIT_COMMIT=$GIT_COMMIT GIT_TAG=$GIT_TAG BUILD_TIME=$BUILD_TIME pnpm build

# Production dependencies stage
FROM node:24-alpine3.23 AS deps

RUN corepack enable

WORKDIR /app

COPY pnpm-lock.yaml package.json ./

RUN pnpm install --prod --frozen-lockfile

# Production stage — linuxserver.io base image with s6-overlay
# Alpine 3.23 ships ffmpeg 8.0.1, which natively decodes xHE-AAC / USAC (audio object
# type 42) — 3.21/3.22 ship 6.1.2, which cannot. Bumped for #1667. Keep the builder/deps
# node:24-alpine3.23 pin above in lockstep (musl ABI).
FROM ghcr.io/linuxserver/baseimage-alpine:3.23 AS runner

WORKDIR /app

ENV NODE_ENV=production

# Install ffmpeg (LSIO base does not include it)
RUN apk add --no-cache ffmpeg

# Copy Node.js binary from builder (Alpine 3.23 does not ship Node 24 packages)
COPY --from=builder /usr/local/bin/node /usr/local/bin/node

# Copy production dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy built application
COPY --from=builder /app/dist ./dist

# Copy migration files (not bundled, loaded at runtime)
COPY --from=builder /app/drizzle ./drizzle

# Copy package files for production install
COPY pnpm-lock.yaml package.json ./

# Ship the third-party notice and the project license alongside the bundled ffmpeg
# binary + node_modules, so the GPL/LGPL + permissive-attribution obligations (and
# Narratorr's own GPL-3.0-only LICENSE) travel to every image puller (#1862).
COPY THIRD_PARTY_NOTICES.md LICENSE ./

# License-compliance build gate (#1862): fail `docker build` — and therefore block the
# atomic build-push — unless the shipped notice + LICENSE are present and non-empty,
# the notice pins the *actually installed* ffmpeg version-release (catches any unpinned
# Alpine 3.23 ffmpeg bump), mentions every covered component and every distinct license
# family + the FFmpeg attribution + the AOM/rav1e patent grant, and contains NO SPDX
# placeholder templates (each permissive component must carry its real notice). Per-arch.
RUN set -eu; \
    test -s /app/THIRD_PARTY_NOTICES.md; \
    test -s /app/LICENSE; \
    V="$(apk info ffmpeg 2>/dev/null | head -n1 | sed -n 's/^ffmpeg-\(.*\) description:.*/\1/p')"; \
    test -n "$V"; \
    grep -q "$V" /app/THIRD_PARTY_NOTICES.md || { echo "notice does not pin installed ffmpeg version-release: $V" >&2; exit 1; }; \
    for c in ffmpeg x264 x265 lame xvidcore aom dav1d libvpx libwebp libvorbis libtheora opus svt-av1 rav1e libjxl libva libvpl shaderc \
             libass libbluray libbz2 fontconfig freetype fribidi harfbuzz lilv libopenmpt libplacebo librist soxr libsrt libssh vidstab \
             libxml2 zimg libzmq libdrm libvdpau alsa-lib libpulse v4l-utils libx11 libxcb; do \
      grep -q "$c" /app/THIRD_PARTY_NOTICES.md || { echo "notice missing covered component: $c" >&2; exit 1; }; \
    done; \
    for h in 'GNU GENERAL PUBLIC LICENSE' 'GNU LESSER GENERAL PUBLIC LICENSE' 'GNU LIBRARY GENERAL PUBLIC LICENSE' \
             'Mozilla Public License' 'Apache License' 'BSD-2-Clause' 'BSD-3-Clause' 'BSD-3-Clause-Clear' \
             'MIT' 'ISC' 'X11' 'bzip2' 'WTFPL' 'Alliance for Open Media Patent License' 'FFmpeg'; do \
      grep -q "$h" /app/THIRD_PARTY_NOTICES.md || { echo "notice missing license family/attribution: $h" >&2; exit 1; }; \
    done; \
    if grep -qE '<year>|<owner>|<copyright holders>|\[Owner Organization\]' /app/THIRD_PARTY_NOTICES.md; then \
      echo "notice contains SPDX placeholder template(s) instead of real component notices" >&2; exit 1; \
    fi

# Copy s6-overlay service definition
COPY docker/root/ /

# Create directories for config and data
RUN mkdir -p /config /audiobooks /downloads

EXPOSE 3000

VOLUME ["/config", "/audiobooks", "/downloads"]

ENV CONFIG_PATH=/config
ENV DATABASE_URL=file:/config/narratorr.db

# Health check — uses URL_BASE env var for subpath deployments
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:3000${URL_BASE:-}/api/health || exit 1
