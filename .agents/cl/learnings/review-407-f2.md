---
scope: [scope/backend]
files: [src/server/services/discovery.service.ts, src/server/services/discovery.service.test.ts]
issue: 407
source: review
date: 2026-03-17
---
Reviewer caught that AC5 (getStrengthForReason handles diversity) lacked a `refreshSuggestions()`-level test proving the full resurfacing path works for snoozed diversity rows. We had unit-level coverage of `getStrengthForReason('diversity')` through `generateCandidates()` and a standalone strength assertion, but the existing snooze resurfacing tests only covered `author` and `narrator` reasons. Each new reason variant needs its own resurfacing test since the `getStrengthForReason` switch cases and the `resurfaceSnoozedRows` affinity-key logic differ per reason. Would have been caught by explicitly listing "snoozed diversity resurfacing" as a test case in the plan.
