---
scope: [backend]
files: [src/server/services/search-pipeline.ts]
issue: 503
date: 2026-04-12
---
`filterAndRankResults` uses positional parameters (10+ args) rather than an options object. Adding a new filter requires updating the function signature and all 6 call sites (3 in search-pipeline.ts, 1 in retry-search.ts, 1 in search.ts job, 1 in rss.ts job). The inline quality type on `searchWithBroadcaster` and `searchAndGrabForBook` also needs updating since it's not derived from the schema.
