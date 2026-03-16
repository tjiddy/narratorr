---
scope: [backend]
files: [src/server/routes/system.test.ts, src/server/routes/update.ts]
issue: 333
source: review
date: 2026-03-10
---
Reviewer caught that `expect.objectContaining({ dismissedUpdateVersion })` doesn't prove existing fields survived the write. The test would pass even if `backupIntervalMinutes` and `backupRetention` were clobbered. Missed because `objectContaining` felt like enough — but it only asserts inclusion, not completeness. Lesson: when testing merge/spread operations, seed with non-default values and assert the EXACT final object.
