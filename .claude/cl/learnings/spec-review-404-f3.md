---
scope: [scope/backend]
files: []
issue: 404
source: spec-review
date: 2026-03-17
---
The reviewer caught that AC5 claimed fractional positions were "excluded by `Number.isInteger()` guard" but the guard is on the loop counter `i` in `computeSeriesGaps()`, not on the book positions during signal extraction. The spec missed this because the auto-generated coverage note was written by reading the code superficially — seeing `Number.isInteger` near the series logic and assuming it filtered input positions. Prevention: when documenting behavior of a loop, trace the actual variable being checked (`i` vs `book.seriesPosition`) rather than inferring from proximity.