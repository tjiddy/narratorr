---
scope: [scope/backend, scope/infra]
files: [docker/entrypoint.sh, docker/entrypoint.test.ts, docker/healthcheck.test.ts]
issue: 292
source: spec-review
date: 2026-03-10
---
Spec described what to build (s6 service, LSIO base image) without listing the existing artifacts that would become stale (entrypoint.sh, entrypoint.test.ts). When a feature replaces existing infrastructure, the spec should enumerate artifacts to remove/rewrite in Technical Notes or Scope to prevent orphaned files.
