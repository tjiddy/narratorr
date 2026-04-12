---
scope: [backend]
files: [src/server/services/search-pipeline.ts, src/server/jobs/search.ts, src/server/jobs/rss.ts, src/server/services/retry-search.ts]
issue: 502
date: 2026-04-12
---
`enrichUsenetLanguages()` was only called from `postProcessSearchResults()` (HTTP route path), but `filterAndRankResults()` is called from 6 different entry points. Adding a preprocessing step to one caller without auditing all callers creates a false sense of completeness. The spec review caught this gap — always grep for all callers of the downstream function, not just the one you're modifying.
