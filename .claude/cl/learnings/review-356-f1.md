---
scope: [backend, services]
files: [src/server/services/quality-gate.service.ts]
issue: 356
source: review
date: 2026-03-15
---
When building chunked IN(...) queries, the chunk size must account for ALL bound parameters in the WHERE clause, not just the IN(...) list. A WHERE clause with `IN(999 IDs) AND eventType = ?` binds 1000 parameters, exceeding SQLite's 999 limit. Each additional predicate reduces the safe chunk size by 1.
