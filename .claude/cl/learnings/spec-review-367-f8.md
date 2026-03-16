---
scope: [scope/frontend]
files: []
issue: 367
source: spec-review
date: 2026-03-16
---
The spec's Dependency Contract section drifted from the actual #366 spec: score was 0-1 here but 0-100 in #366, and the stats endpoint was reinvented as `{ totalSuggestions, libraryBookCount, lastRefreshed }` when #366 defines it as counts by reason type. When a frontend spec imports a backend contract, the imported values must be copied verbatim from the dependency spec, not paraphrased or reinterpreted. Cross-reference the exact field names and value ranges.
