---
scope: [frontend]
files: [src/client/pages/library/helpers.ts]
issue: 365
date: 2026-04-06
---
`collapseSeries()` previously returned collapsed items in Map insertion order, not re-sorted. When the visible label on collapsed cards differs from the representative book's title (e.g., series "The Expanse" shown on card vs book "Leviathan Wakes"), the sort position must use the visible label. For title sorts, `toSortTitle(seriesName)` is the correct key, not `toSortTitle(representative.title)`. A post-collapse re-sort with a field-aware extractor handles this cleanly.
