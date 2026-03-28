---
scope: [scope/backend]
files: []
issue: 404
source: spec-review
date: 2026-03-17
---
Reviewer caught that the fractional-position worked example `[1.5, 2.5] → missingPositions: [2, 3.5]` was wrong — the loop starts at 1.5 and increments by 1, so it visits 1.5, 2.5 and never lands on integer 2. Actual output is `[3.5]` only.

Root cause: I traced the `Number.isInteger(i)` guard but didn't trace the loop initialization (`Math.min(...sorted)`) to realize the counter inherits the fractional part. Each round fixed the description but copied the same wrong example forward.

Prevention: When writing worked examples for loop-based algorithms, trace the actual loop variable values step by step (init, increment, each iteration) before asserting the output. Don't reason about the filter condition in isolation — reason about what values the loop counter actually takes.
