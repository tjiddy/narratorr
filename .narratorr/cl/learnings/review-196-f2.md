---
scope: [backend]
files: [src/server/services/discovery.service.test.ts]
issue: 196
source: review
date: 2026-03-29
---
When fixing a bug that affects a data pipeline (computation → filtering → scoring), integration tests must exercise the full pipeline with the bug-triggering inputs, not just the computation layer. Unit tests for `computeSeriesGaps` proved the math was correct but didn't catch that downstream filtering/scoring would fail for the same fractional values due to exact equality.
