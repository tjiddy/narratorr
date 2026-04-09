---
scope: [backend]
files: [src/server/services/quality-gate.service.ts]
issue: 413
date: 2026-04-09
---
When adding single-record query variants of batch methods in QualityGateService, the narrator attachment pattern (batch join via bookNarrators + narrators) must be replicated but simplified — a single-record lookup can query narrators directly by bookId instead of using an inArray batch. The existing `approve()` and `reject()` methods show the left-join pattern but skip narrator attachment, so `getCompletedDownloads()` is the only reference for the narrator join.
