---
scope: [scope/backend]
files: [src/server/jobs/index.ts, src/server/jobs/import.ts]
issue: 279
source: spec-review
date: 2026-03-10
---
When enumerating jobs for a TaskRegistry test plan, cross-reference the full `startJobs()` function in `src/server/jobs/index.ts` to ensure all jobs on main are listed. The import job (cron-based) was omitted from the test list despite being called in startJobs(). Always enumerate from the source-of-truth wiring file, not from memory.
