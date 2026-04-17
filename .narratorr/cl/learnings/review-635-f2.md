---
scope: [backend, services]
files: [src/server/services/import-queue-worker.ts]
issue: 635
source: review
date: 2026-04-17
---
When copying the SQLite conditional-update claim pattern from ImportService.claimQueuedDownload, the `rowsAffected === undefined` guard was missed. This is a critical defensive check because Drizzle/libSQL doesn't type rowsAffected reliably — without it, undefined rowsAffected causes an infinite loop on the same pending row. Always copy the full pattern including error guards, not just the happy path.
