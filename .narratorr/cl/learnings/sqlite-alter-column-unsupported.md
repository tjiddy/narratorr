---
scope: [backend, db]
files: [drizzle/0002_fat_stephen_strange.sql, src/db/schema.ts]
issue: 248
date: 2026-03-31
---
Drizzle `db:generate` emits `ALTER TABLE ... ALTER COLUMN` for NOT NULL → nullable changes, but SQLite doesn't support `ALTER COLUMN`. The migration runs fine in Drizzle's push mode but fails with `SQLITE_ERROR` during file-based migration. Must manually remove the `ALTER COLUMN` line — SQLite doesn't enforce column-level NOT NULL via ALTER TABLE anyway (existing rows keep their values, new inserts follow application-level validation).
