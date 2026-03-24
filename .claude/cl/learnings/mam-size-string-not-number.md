---
scope: [core]
files: [src/core/indexers/myanonamouse.ts, src/core/indexers/myanonamouse.test.ts]
issue: 28
date: 2026-03-20
---
MAM's search API returns `size` as a human-readable string like `"881.8 MiB"` — not raw bytes. The adapter typed it `number`, so the string passed through silently producing NaN everywhere. Fix pattern: widen the internal interface type (`string | number`), add a private `parseSize(raw)` helper following ABB's prior art, and update test fixtures to use realistic string values. The key risk was that `makeResult()` using a numeric mock masked the bug in all pre-existing tests — always use realistic fixture shapes matching actual API responses.
