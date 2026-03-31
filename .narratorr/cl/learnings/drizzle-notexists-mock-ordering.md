---
scope: [backend]
files: [src/server/services/book.service.ts, src/server/services/book.service.test.ts]
issue: 253
date: 2026-03-31
---
When using Drizzle's `notExists(this.db.select(...))` in a query, the subquery's `this.db.select()` call consumes a mock from the `db.select` mock queue. JS evaluation order means the outer `db.select()` is consumed first (mock #1), then the inner `db.select()` for the subquery is consumed second (mock #2) during argument evaluation. All existing tests using the title-only branch need their mock stacks updated to include the extra subquery mock. This ordering is non-obvious and caused initial test failures.
