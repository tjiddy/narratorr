# Build stage
FROM node:20-alpine AS builder

# Enable corepack for pnpm
RUN corepack enable

WORKDIR /app

# Copy package files
COPY pnpm-lock.yaml package.json ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code and configs
COPY src/ src/
COPY tsconfig.json tsup.config.ts vite.config.ts ./

# Build application
RUN pnpm build

# Production stage — linuxserver.io base image with s6-overlay
FROM ghcr.io/linuxserver/baseimage-alpine:3.21 AS runner

WORKDIR /app

ENV NODE_ENV=production

# Install Node.js and ffmpeg (LSIO base does not include Node)
RUN apk add --no-cache nodejs ffmpeg

# Install pnpm for production dependencies
RUN corepack enable

# Copy package files for production install
COPY pnpm-lock.yaml package.json ./

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile

# Copy built application
COPY --from=builder /app/dist ./dist

# Copy migration files (not bundled, loaded at runtime)
COPY --from=builder /app/drizzle ./drizzle

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
