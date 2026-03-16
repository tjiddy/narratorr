---
scope: [type/chore]
files: []
issue: 352
source: spec-review
date: 2026-03-14
---
AC4 said "re-run the same check that caught the original issue" but didn't define what that means for manual review findings (which are prose observations, not runnable commands). The AC was underspecified because it assumed all review findings would have a corresponding repeatable check. Should have defined a fallback hierarchy for non-automatable verification steps.
