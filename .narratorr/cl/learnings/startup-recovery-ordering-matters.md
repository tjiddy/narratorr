---
scope: [backend, services]
files: [src/server/index.ts, src/server/services/import-queue-worker.ts]
issue: 636
date: 2026-04-17
---
When both job-level and download-level recovery run at startup, ordering matters. ImportQueueWorker.start() (boot recovery) must complete before startJobs() fires runStartupRecovery(), otherwise a race condition can mark a job as failed AND re-enqueue the same download simultaneously. The fix is to `await worker.start()` before calling `startJobs()`.
