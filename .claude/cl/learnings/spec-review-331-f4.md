---
scope: [scope/backend]
files: [src/server/jobs/index.ts]
issue: 331
source: spec-review
date: 2026-03-10
---
Spec said "auto-cleanup runs daily" without stating whether it's a new task or a modification to the existing weekly `housekeeping` task. This matters because changing housekeeping cadence from weekly to daily would affect VACUUM, event-history pruning, and blacklist cleanup as collateral. Prevention: when adding scheduled work, always state: (a) new task or existing, (b) exact cron expression, (c) what existing tasks are NOT changed. Check `jobs/index.ts` for current task registrations.
