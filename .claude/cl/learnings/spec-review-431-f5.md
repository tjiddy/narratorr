---
scope: [scope/core]
files: [src/core/notifiers/registry.ts, src/shared/notification-events.ts]
issue: 431
source: spec-review
date: 2026-03-17
---
Reviewer caught stale notifier inventory: spec said "7 adapters" but registry has 9, and only 6 have EVENT_TITLES. Prevention: when referencing adapter/consumer counts, read the registry file and grep for the actual pattern to get an exact count.
