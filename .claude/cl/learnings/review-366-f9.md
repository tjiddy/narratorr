---
scope: [scope/backend]
files: [src/server/jobs/index.ts, src/server/jobs/index.test.ts]
issue: 366
source: review
date: 2026-03-16
---
When testing timeout-loop scheduling with configurable intervals, asserting that `settings.get(category)` was called is necessary but not sufficient — it doesn't prove the value transformation (e.g., `intervalHours * 60`) is correct. Must capture the actual delay value passed to `setTimeout` via a spy and assert the computed ms value. Regression-tested by temporarily removing the `* 60` multiplier and confirming the test fails.
