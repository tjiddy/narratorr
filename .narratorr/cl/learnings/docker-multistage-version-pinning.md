---
scope: [backend, infra]
files: [Dockerfile]
issue: 383
date: 2026-03-15
---
Multi-stage Docker builds can have different Node versions in builder vs runner. The builder pins via base image (`FROM node:22-alpine`), but the runner installs Node via `apk add nodejs` which floats to whatever Alpine provides. Must pin with `apk add 'nodejs~=22'` and verify `node --version` inside the built container. Spec reviewer caught this gap — the original spec only checked `/api/health` returns 200.
