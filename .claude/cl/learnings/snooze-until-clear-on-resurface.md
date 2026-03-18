---
scope: [backend]
files: [src/server/services/discovery.service.ts]
issue: 408
date: 2026-03-17
---
When a snoozed suggestion resurfaces (snoozeUntil in the past), the snoozeUntil field must be cleared to null. Otherwise the row matches the resurfaced filter on every subsequent refresh, causing an infinite re-score loop. Self-review caught this — would have been prevented by writing a test that asserts snoozeUntil is null after a full refresh cycle with a resurfaced row.
