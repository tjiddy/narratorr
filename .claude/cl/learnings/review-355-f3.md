---
scope: [backend, services]
files: [src/server/services/book.service.test.ts, src/server/services/download.service.test.ts, src/server/services/event-history.service.test.ts, src/server/services/blacklist.service.test.ts]
issue: 355
source: review
date: 2026-03-14
---
When adding sort order as a spec requirement (AC5), the sort contract must be tested — not just the data it returns. Assert that `orderBy` is called with the expected number of columns. Without this, removing the secondary sort by id would silently regress pagination stability.
