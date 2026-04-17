---
scope: [backend, db]
files: [src/server/services/import-queue-worker.ts, src/server/services/import.service.ts]
issue: 635
date: 2026-04-17
---
SQLite queue claim pattern: SELECT oldest candidate → UPDATE WHERE id=? AND status='pending' → check rowsAffected === 1. The rowsAffected check is critical — without it, a concurrent claim silently succeeds on already-claimed rows. The cast `(result as unknown as { rowsAffected?: number }).rowsAffected` is required because Drizzle's libSQL driver doesn't expose rowsAffected in its typed return. This pattern already existed in `ImportService.claimQueuedDownload()` and should be followed for any future queue-style tables.
