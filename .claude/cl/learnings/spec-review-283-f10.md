---
scope: [scope/frontend]
files: []
issue: 283
source: spec-review
date: 2026-03-10
---
The grab_started event contract text said "invalidate activity, activityCounts" but the cache invalidation matrix also included eventHistory. The matrix was correct (grabs create event history records) but the contract text was inconsistent. Prevention: when building an event-to-cache matrix alongside per-event contract descriptions, cross-check each event's contract text against its matrix row before finalizing to catch copy-paste inconsistencies.
