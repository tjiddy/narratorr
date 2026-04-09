---
scope: [backend]
files: [src/server/services/book.service.ts]
issue: 437
date: 2026-04-09
---
When adding backfill logic to a find-or-create function that has a unique-constraint catch+retry path, the backfill must be applied in BOTH the primary lookup path AND the retry path. The retry path re-SELECTs after a failed INSERT, and the returned row may also need enrichment. Missing the retry path means concurrent creation races silently skip the backfill.
