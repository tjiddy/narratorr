---
scope: [backend, db]
files: [src/server/services/import-list.service.ts, src/db/schema.ts]
issue: 285
source: review
date: 2026-03-11
---
SQLite unique indexes treat NULL as distinct — `(title, NULL)` never conflicts with another `(title, NULL)`. When dedup relies on a compound unique index with a nullable column, the code must ensure that column is populated. For author dedup: create the author row first (insert-or-select) before inserting the book, so `authorId` is never NULL when an author name is available.
