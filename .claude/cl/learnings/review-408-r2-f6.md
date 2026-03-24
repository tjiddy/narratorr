---
scope: [scope/backend, scope/services]
files: [src/server/services/discovery.service.test.ts]
issue: 408
source: review
date: 2026-03-17
---
No test covered a still-snoozed row surviving refresh unchanged. The future-snooze branch and the resurfacing branch are independently breakable — both need dedicated tests. When implementing two complementary branches (snooze active vs expired), test each in isolation.
