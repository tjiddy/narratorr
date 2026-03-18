---
scope: [scope/backend, scope/services]
files: [src/server/services/discovery.service.test.ts]
issue: 408
source: review
date: 2026-03-17
---
The AC6 resurfacing test only checked db.update was called, not WHAT it was called with. Must assert: (1) snoozeUntil=null in set payload, (2) reason/reasonContext NOT in set payload (preservation by omission), (3) score matches real algorithm output. "Assert values, not invocations" — toHaveBeenCalled() proves nothing about correctness.
