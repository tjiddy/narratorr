---
scope: [backend, services]
files: [src/server/utils/import-helpers.ts]
issue: 397
source: review
date: 2026-04-07
---
`localeCompare` with `{ numeric: true }` sorts by full string including prefix, so `CD 10` sorts before `Disc 2` (because `C` < `D`). When sorting items that share a semantic number across different prefixes (disc folders: CD, Disc, Disk), extract the number and sort numerically. The regex already captured the number — should have used it for sorting, not just detection.
