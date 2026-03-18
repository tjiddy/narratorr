---
scope: [scope/backend, scope/services]
files: [src/server/services/discovery.service.test.ts]
issue: 408
source: review
date: 2026-03-17
---
Mock DB tests that only assert `.where()` was called don't prove the predicate shape — any WHERE clause passes. When testing Drizzle ORM query predicates with mock DB, use `SQLiteSyncDialect.sqlToQuery()` to serialize the predicate argument and assert the SQL string contains the expected column names, operators, and structure. This catches regressions where the predicate changes shape (e.g., `lt` → `lte`, dropped guard clause).
