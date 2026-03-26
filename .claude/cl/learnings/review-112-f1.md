---
scope: [scope/frontend, scope/backend, scope/db]
files: [src/client/pages/book/BookDetails.tsx, src/db/schema.ts, src/server/services/enrichment-utils.ts]
issue: 112
source: review
date: 2026-03-26
---
The frontend merge eligibility gate used `audioFileCount` (recursive total) to guard the Merge button, but the backend validates against top-level audio files only (non-recursive readdir). A book with disc subdirectories (Disc 1/*.mp3, Disc 2/*.mp3) passes the frontend check but the backend rejects with NO_TOP_LEVEL_FILES.

Why we missed it: the spec said "books with multiple top-level audio files" but the implementation used the simpler `audioFileCount > 1` check without realizing audioFileCount includes nested files. The gap wasn't visible from the DB schema alone — it required tracing how audioFileCount is populated (via `scanAudioDirectory` which is recursive).

What would have prevented it: during /plan, when mapping frontend eligibility conditions to backend guards, explicitly verify that the data source for the frontend check (DB field) maps to the same set of items the backend validates against. If they come from different scans (recursive vs non-recursive), a schema field gap exists and needs to be filled.
