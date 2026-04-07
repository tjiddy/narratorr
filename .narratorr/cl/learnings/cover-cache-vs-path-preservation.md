---
scope: [backend, services]
files: [src/server/services/book-rejection.service.ts, src/server/utils/cover-cache.ts, src/server/routes/books.ts]
issue: 396
date: 2026-04-07
---
Preserving `book.path` after wrong-release to keep cover art visible conflicts with 5+ path-based consumers (quality gate, revertBookStatus, monitor, download orchestrator) that treat non-null path as "has imported audio." A cover cache (copy-out to `{configPath}/covers/{bookId}/`) avoids this entirely — null path as before, serve from cache when needed. Always check all consumers of a field before changing its nulling behavior.
