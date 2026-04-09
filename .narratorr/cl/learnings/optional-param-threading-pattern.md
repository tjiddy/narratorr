---
scope: [backend]
files: [src/server/services/search-pipeline.ts, src/server/jobs/search.ts, src/server/routes/books.ts]
issue: 439
date: 2026-04-09
---
When adding a feature that should only activate in auto-grab paths (not manual search), use an optional parameter on the shared helper (`filterAndRankResults`) rather than splitting the function. The caller builds the config object (`buildNarratorPriority`), and omitting the parameter preserves exact existing behavior. This is cleaner than adding feature flags or if-chains inside the shared helper.