---
scope: [backend, core]
files: [src/server/services/search-pipeline.ts]
issue: 394
date: 2026-04-07
---
canonicalCompare uses `b - a` (descending) for "higher wins" tiers but `a - b` (ascending) for "lower wins" tiers like indexer priority. When adding a new tier, check whether the field semantics mean "more is better" (descending) or "less is better" (ascending) before choosing the subtraction order. The existing priority field uses lower = more preferred everywhere (DB ordering, UI copy), so the tier must be ascending.
