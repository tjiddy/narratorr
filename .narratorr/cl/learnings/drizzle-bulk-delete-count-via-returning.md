---
scope: [backend, db]
files: [src/server/services/download.service.ts]
issue: 54
date: 2026-03-21
---
Drizzle ORM does not expose `.rowsAffected` on delete results without a cast. Use `.returning({ id: downloads.id })` and count `rows.length` instead — this works cleanly with libSQL/SQLite and avoids type gymnastics.
