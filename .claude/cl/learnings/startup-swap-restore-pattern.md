---
scope: [backend, db]
files: [src/server/services/backup.service.ts, src/server/index.ts]
issue: 280
date: 2026-03-10
---
SQLite database file replacement while a libSQL client holds it open is unsafe. The correct pattern is a startup swap: stage the replacement file to a well-known path (restore-pending.db), exit the process, and on next boot swap the file in BEFORE opening any DB connections (before runMigrations/createDb). This was caught during spec review and implemented as `applyPendingRestore()` called at line 86 of index.ts, before line 89's `runMigrations()`. The function handles cross-device rename failure with a copy+delete fallback.
