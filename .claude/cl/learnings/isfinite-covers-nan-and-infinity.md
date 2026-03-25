---
scope: [backend, core]
files: [src/core/utils/parse.ts]
issue: 83
date: 2026-03-25
---
`!isFinite(bytes)` is sufficient to guard against both NaN and Infinity in a single check — no separate `isNaN()` call needed. `isFinite(NaN)` returns `false`, so the guard `if (!isFinite(bytes) || bytes < 0) return '0 B'` covers all three bad-input cases. The client-side `formatBytes` in `src/client/lib/api/utils.ts` already used this pattern and was the reference.
