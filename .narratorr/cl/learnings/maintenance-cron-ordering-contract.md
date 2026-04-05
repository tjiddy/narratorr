---
scope: [backend]
files: [src/server/jobs/index.ts]
issue: 358
date: 2026-04-05
---
When replacing a cron job that calls multiple orchestrators in sequence, the ordering contract must be explicitly preserved. `getEligibleDownloads()` queries both `completed` and `processing_queued` — if the quality gate batch doesn't run first, raw `completed` downloads bypass quality gate entirely. This was caught during spec review but would have been a silent behavioral regression.