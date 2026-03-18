---
scope: [backend, services]
files: [src/server/services/quality-gate.service.ts]
issue: 356
date: 2026-03-15
---
When batch-fetching events with `IN(...)` + `ORDER BY id DESC`, the result set may contain multiple events per download. The dedup logic must check if a result has already been set before overwriting (take first = most recent). Using `result.get(id) === null` as the guard works because all IDs are initialized to null upfront, so first non-null write wins.
