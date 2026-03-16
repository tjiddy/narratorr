---
scope: [scope/backend, scope/api]
files: [src/server/routes/books.test.ts, src/server/jobs/search.ts]
issue: 282
source: review
date: 2026-03-10
---
The per-book search route had tests for the active-download skip path and indexer failure, but missed the generic `downloadService.grab()` failure that rethrows and hits the route's catch block for a 500 response. When a function has a catch block with branching logic (special-case vs rethrow), every branch needs its own test — the rethrow path is the most likely to regress silently.
