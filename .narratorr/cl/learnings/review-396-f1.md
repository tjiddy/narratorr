---
scope: [backend, services]
files: [src/server/routes/books.ts]
issue: 396
source: review
date: 2026-04-07
---
DB-1 violation: placed `cleanCoverCache()` (filesystem op) before `bookService.delete()` (DB op) in the DELETE route. If the DB delete fails, the cached cover is already gone. The self-review didn't catch this because the focus was on wrong-release ordering (which was correct), not the DELETE route's ordering. Fix: always place irreversible filesystem cleanup AFTER the corresponding DB mutation succeeds.
