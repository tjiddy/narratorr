---
scope: [scope/backend, scope/services]
files: [src/server/services/download.service.ts]
issue: 434
source: spec-review
date: 2026-03-18
---
Spec said grab event recording only needs `bookId/downloadId/eventType`, but grab() also passes `source` (e.g., 'rss', 'auto') and reason metadata (indexerId, size, protocol). When extracting side effects through an orchestrator, check ALL parameters that flow through the extracted call — event attribution is easy to silently erase.
