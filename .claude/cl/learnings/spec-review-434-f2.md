---
scope: [scope/backend, scope/services]
files: [src/server/services/download.service.ts]
issue: 434
source: spec-review
date: 2026-03-18
---
Spec only listed route entry points for rewiring, but `DownloadService.grab()` is also called from search-pipeline, retry-search, RSS job, and upgrade search job. `cancel()` is called from book deletion in routes/books.ts. When extracting a service into an orchestrator, grep for ALL callers of every method being wrapped — not just the route layer. The caller matrix pattern from #436 should be standard for any extraction spec.
