---
scope: [backend]
files: [src/server/services/import.service.test.ts]
issue: 96
date: 2026-03-26
---
When consolidating duplicate describe blocks, check whether "duplicate" tests actually cover distinct scenarios before removing them. In import.service.test.ts, the two getEligibleDownloads blocks shared two test names but the second block had a unique semaphore overflow test (sets overflow downloads to processing_queued). Read both blocks fully before deciding what to merge vs. keep.
