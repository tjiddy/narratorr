---
scope: [backend, db]
files: [drizzle/0002_fat_stephen_strange.sql]
issue: 248
date: 2026-03-31
---
Drizzle migrations may emit `CREATE INDEX` on a new column BEFORE the `ALTER TABLE ADD` that creates it, causing `SQLITE_ERROR: no such column`. Also emits `DROP INDEX` for indexes that don't exist yet (new in this migration). Fix: manually reorder `ALTER TABLE ADD` statements before `CREATE INDEX`, and use `DROP INDEX IF EXISTS` for new indexes.
