# Build stage
FROM node:20-alpine AS builder

# Enable corepack for pnpm
RUN corepack enable

WORKDIR /app

# Copy workspace configuration
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY tsconfig.json ./

# Copy package.json files
COPY apps/narratorr/package.json apps/narratorr/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY apps/ apps/

# Build application
RUN pnpm --filter narratorr build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Install ffmpeg for audio processing (merge/convert)
RUN apk add --no-cache ffmpeg

# Install pnpm for production dependencies
RUN corepack enable

# Copy workspace configuration for production install
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/narratorr/package.json apps/narratorr/

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile

# Copy built application
COPY --from=builder /app/apps/narratorr/dist ./apps/narratorr/dist

# Copy migration files (not bundled, loaded at runtime)
COPY --from=builder /app/apps/narratorr/drizzle ./apps/narratorr/drizzle

# Create directories for config and data
RUN mkdir -p /config /audiobooks /downloads

EXPOSE 3000

VOLUME ["/config", "/audiobooks", "/downloads"]

ENV CONFIG_PATH=/config
ENV LIBRARY_PATH=/audiobooks
ENV DATABASE_URL=file:/config/narratorr.db

WORKDIR /app/apps/narratorr

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://localhost:3000/api/health || exit 1

CMD ["node", "dist/server/index.js"]
