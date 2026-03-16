---
scope: [scope/backend, scope/infra]
files: [Dockerfile]
issue: 292
source: spec-review
date: 2026-03-10
---
AC referenced an external Docker image with `(or current)` wording instead of pinning an exact registry/tag. Acceptance criteria must be pass/fail testable — version flexibility belongs in Technical Notes, not ACs. When specifying external image dependencies, always include the full registry path and tag (e.g., `ghcr.io/linuxserver/baseimage-alpine:3.21`).
