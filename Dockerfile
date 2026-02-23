# Build stage
FROM node:20-alpine AS builder

# Enable corepack for pnpm
RUN corepack enable

WORKDIR /app

# Copy workspace configuration
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY turbo.json tsconfig.json ./

# Copy package.json files for all packages
COPY apps/narratorr/package.json apps/narratorr/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/ui/package.json packages/ui/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY apps/ apps/
COPY packages/ packages/

# Build all packages
RUN pnpm turbo build --filter=narratorr...

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
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/ui/package.json packages/ui/

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile

# Copy built application
COPY --from=builder /app/apps/narratorr/dist ./apps/narratorr/dist
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/db/drizzle ./packages/db/drizzle
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/ui/dist ./packages/ui/dist

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
