---
scope: [backend, services]
files: [src/server/services/event-history.service.ts, src/server/services/download.service.ts, src/server/services/book.service.ts, src/server/services/blacklist.service.ts]
issue: 355
date: 2026-03-13
---
Drizzle ORM doesn't support `SQL_CALC_FOUND_ROWS` or automatic total counting with limit/offset. Each paginated query requires two DB calls: a `count()` query (with filters, without pagination) and a data query (with filters + limit/offset). This doubles the mock setup needed in tests — each `getAll()` test must mock two `db.select` calls (`mockReturnValueOnce` for count, then for data).
