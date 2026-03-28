---
scope: [scope/backend, scope/services]
files: [src/server/services/discovery.service.ts]
issue: 408
source: review
date: 2026-03-17
---
Future-snoozed rows were deleted as stale during refresh because the stale filter only excluded regenerated and resurfaced rows, not still-active snoozed ones. Missed because the stale-delete logic was written before the snooze feature was fully integrated — the interaction between "not regenerated" and "actively snoozed" wasn't tested. A test seeding a future-snoozed non-regenerated row and asserting it survives refresh would have caught this.
