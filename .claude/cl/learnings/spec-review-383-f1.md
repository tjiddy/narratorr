---
scope: [scope/backend, scope/infra]
files: [Dockerfile, .gitea/workflows/docker.yaml]
issue: 383
source: spec-review
date: 2026-03-15
---
Reviewer caught that Docker AC only checked `/api/health` returns 200, but never verified the runtime container is actually running Node 22. The Dockerfile runner stage uses `apk add nodejs` (floating version from Alpine), so the builder could be Node 22 while the runtime stays on whatever Alpine provides.

Why missed: focused on the builder stage `FROM` line and assumed the runner would match. Didn't trace the full Docker multi-stage build to notice the runner installs Node independently via Alpine packages.

Prevention: when writing specs that change version targets in multi-stage Docker builds, verify each stage's Node source independently. Builder = pinned base image. Runner = package manager install (floating unless pinned).
