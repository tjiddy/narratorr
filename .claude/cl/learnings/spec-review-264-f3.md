---
scope: [scope/backend]
files: [src/server/services/indexer.service.ts, src/server/routes/search.ts]
issue: 264
source: spec-review
date: 2026-03-08
---
AC required distinguishing auth failures from search failures, but didn't check how `searchAll` handles errors — it catches all adapter errors and only logs warn. The spec assumed error types would be observable without verifying the actual error propagation path. ACs about error handling must specify WHERE the distinction is observable (API response, logs, UI).
