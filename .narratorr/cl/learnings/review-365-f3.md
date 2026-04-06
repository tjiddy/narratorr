---
scope: [frontend]
files: [src/client/pages/library/helpers.ts, src/client/pages/library/helpers.test.ts]
issue: 365
source: review
date: 2026-04-06
---
New sort comparator branches (especially equality/tiebreak paths) need explicit tests with equal keys. Tests using only distinct keys never execute the `cmp === 0` branch, leaving the tiebreaker logic unproven. Always include at least one test with equal extracted values to cover the fallback path.
