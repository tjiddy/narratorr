---
scope: [backend, infra]
files: [Dockerfile]
issue: 292
date: 2026-03-10
---
LSIO baseimage-alpine does NOT include Node.js. Must install via `apk add --no-cache nodejs` in the Dockerfile. Also need `corepack enable` for pnpm. The builder stage still uses node:20-alpine for the build, but the runner needs Node installed separately.
