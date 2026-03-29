---
scope: [backend]
files: [src/server/services/discovery-candidates.ts]
issue: 196
source: review
date: 2026-03-29
---
When adding floating-point tolerance to a computation, the tolerance must be carried through to ALL downstream consumers that compare the computed values. In this case, `computeSeriesGaps` was updated to use `nearlyEqual()` but the downstream filter and bonus logic in `discovery-candidates.ts` still used exact `===` equality, allowing IEEE 754 drift to break fractional position matching. The self-review should have traced the data flow through consumers and verified that tolerance-aware comparison was applied at every comparison site.
