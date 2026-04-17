---
scope: [backend, services]
files: [src/server/utils/enqueue-auto-import.ts]
issue: 636
date: 2026-04-17
---
When multiple entrypoints need to create the same type of import_jobs row (3 callers in this case), extract a shared helper with duplicate protection rather than inlining the insert+status-update+nudge pattern in each caller. The duplicate check (query pending/processing rows and compare metadata) must happen in application code since SQLite+Drizzle don't support JSON extraction in WHERE clauses efficiently.
