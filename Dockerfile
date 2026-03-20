# Build stage
FROM node:24-alpine AS builder

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

# Accept git commit SHA as a build arg (pass with --build-arg GIT_COMMIT=$(git rev-parse --short HEAD))
ARG GIT_COMMIT=unknown

# Build application — GIT_COMMIT is inlined into the server bundle by tsup esbuildOptions
RUN GIT_COMMIT=$GIT_COMMIT pnpm build

# Production dependencies stage
FROM node:24-alpine AS deps

RUN corepack enable

WORKDIR /app

COPY pnpm-lock.yaml package.json ./

RUN pnpm install --prod --frozen-lockfile

# Production stage — linuxserver.io base image with s6-overlay
FROM ghcr.io/linuxserver/baseimage-alpine:3.21 AS runner

WORKDIR /app

ENV NODE_ENV=production

# Install ffmpeg (LSIO base does not include it)
RUN apk add --no-cache ffmpeg

# Copy Node.js binary from builder (Alpine 3.21 does not ship Node 24 packages)
COPY --from=builder /usr/local/bin/node /usr/local/bin/node

# Copy production dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy built application
COPY --from=builder /app/dist ./dist

# Copy migration files (not bundled, loaded at runtime)
COPY --from=builder /app/drizzle ./drizzle

# Copy package files for production install
COPY pnpm-lock.yaml package.json ./

# Copy s6-overlay service definition
COPY docker/root/ /

# Create directories for config and data
RUN mkdir -p /config /audiobooks /downloads

EXPOSE 3000

VOLUME ["/config", "/audiobooks", "/downloads"]

ENV CONFIG_PATH=/config
ENV LIBRARY_PATH=/audiobooks
ENV DATABASE_URL=file:/config/narratorr.db

# Health check — uses URL_BASE env var for subpath deployments
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:3000${URL_BASE:-}/api/health || exit 1
