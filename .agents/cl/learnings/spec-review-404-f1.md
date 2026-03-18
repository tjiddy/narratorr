---
scope: [scope/backend]
files: []
issue: 404
source: spec-review
date: 2026-03-17
---
Reviewer caught that AC5 claimed "completed series" and "single-book series" were already handled, but `computeSeriesGaps()` always appends `maxOwned + 1` — there is no total-series-length concept. The spec auto-generation inferred behavior from function names rather than reading the actual logic. When claiming existing code satisfies an AC, verify the exact algorithm path, not just that a relevant-sounding function exists.
