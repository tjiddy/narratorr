---
scope: [backend, core]
files: [src/server/services/search-pipeline.ts]
issue: 394
date: 2026-04-07
---
For ascending tiebreaker tiers (lower wins), missing values should default to `Infinity` — not `0`. Using `0` would make missing values the highest priority, which is the opposite of the intended "loses all ties" behavior. This is the inverse of descending tiers where `?? 0` correctly makes missing values the lowest. The spec review caught an initial design using `0` that would have inverted behavior.
