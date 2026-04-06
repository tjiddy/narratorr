---
scope: [backend]
files: [src/server/services/indexer.service.ts]
issue: 385
date: 2026-04-06
---
`IndexerService.pollRss()` was missing the `indexerId: indexer.id` mapping that `searchAll()` has at line 366. When adding new fields to `SearchResult` population, check ALL code paths that produce `SearchResult[]` — `searchAll()`, `searchAllStreaming()`, and `pollRss()` — not just the primary search path. The RSS path is easy to miss because it shares the same return type but has a separate code path.
