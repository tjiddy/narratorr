---
scope: [scope/backend, scope/services]
files: [src/server/jobs/index.ts, src/server/services/task-registry.ts]
issue: 285
source: spec-review
date: 2026-03-11
---
Spec said "sync interval configurable per list" without defining the scheduling model. The current job infrastructure uses fixed singleton tasks (one timer per named task), not per-DB-row scheduling. /elaborate should have identified that per-entity scheduling is a new pattern not supported by existing infrastructure and required an explicit design decision (single poller querying due rows vs dynamic timers).
