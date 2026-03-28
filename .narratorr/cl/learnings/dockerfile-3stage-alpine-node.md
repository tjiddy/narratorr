---
scope: [infra]
files: [Dockerfile, docker/s6-service.test.ts]
issue: 428
date: 2026-03-17
---
Alpine 3.21 (LSIO baseimage) doesn't ship Node 24 packages yet, so the runner stage must COPY the Node binary from the builder stage rather than using `apk add nodejs`. A dedicated `deps` stage (`FROM node:24-alpine AS deps`) running `pnpm install --prod --frozen-lockfile` keeps build tools out of the runner while providing pre-built production node_modules. This 3-stage pattern (builder → deps → runner) is cleaner than running corepack/pnpm in the runner stage.
