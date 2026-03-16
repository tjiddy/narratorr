---
scope: [scope/backend, scope/infra]
files: [docker/entrypoint.sh, docker-compose.yml]
issue: 292
source: spec-review
date: 2026-03-10
---
Current State section said "No PUID/PGID support" when the repo already had a working implementation via docker/entrypoint.sh and su-exec (added in #284). The spec was written as if the feature was greenfield when it was actually a migration/replacement. Always check the actual codebase state before writing Current State — don't copy from an outdated mental model.
