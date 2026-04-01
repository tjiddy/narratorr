---
scope: [core]
files: [src/core/indexers/newznab.ts, src/core/indexers/torznab.ts]
issue: 272
date: 2026-04-01
---
When adding NaN guards to numeric attr parsing (e.g., `Number.isNaN` check on grabs), pre-existing tests may assert `toBeNaN()` for invalid values. Changing from NaN to undefined breaks those tests — check both newznab and torznab for parallel NaN assertions before implementing the guard.
