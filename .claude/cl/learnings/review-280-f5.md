---
scope: [scope/backend]
files: [src/server/jobs/backup.ts, src/server/jobs/backup.test.ts, src/server/jobs/index.test.ts]
issue: 280
source: review
date: 2026-03-10
---
startBackupJob() with dynamic-interval scheduling and error retry was added but only runBackupJob() was tested. The index.test.ts was not updated to assert the new wiring. Root cause: tests for the job's "runner" were written but the "scheduler" and "wiring" layers were skipped. Prevention: when adding a new job, always test three layers: runner behavior, scheduler contract (interval/retry), and startup wiring.
