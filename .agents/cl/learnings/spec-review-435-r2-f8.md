---
scope: [scope/backend, scope/services]
files: []
issue: 435
source: spec-review
date: 2026-03-18
---
Reviewer caught that the cron caller matrix still pointed at `jobs/import.ts:11` (a legacy helper) instead of `jobs/index.ts:33` (the live production registration). Both files call `processCompletedDownloads()`, but the live entry point is in `jobs/index.ts` where the cron task is registered. Root cause: the round-1 fix corrected the caller matrix partially but didn't distinguish between the live registration path and the legacy helper. Prevention: when correcting caller matrices, verify which file is the actual registration/entry point vs. a helper that gets called by it.
