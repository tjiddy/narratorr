---
scope: [backend]
files: [src/server/services/cover-download.ts, src/server/jobs/index.ts]
issue: 369
source: review
date: 2026-04-06
---
When using a fixed temp filename pattern (e.g., `.cover-download-{bookId}.tmp`), concurrent downloads for the same book (e.g., fire-and-forget enrichment + immediate startup backfill) can collide on the same temp file. Fix: use `randomUUID()` in temp filenames. This is especially relevant for fire-and-forget patterns where the caller doesn't await the result — a second trigger can arrive before the first completes.
