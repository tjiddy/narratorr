---
scope: [scope/backend, scope/services]
files: [src/server/jobs/search.ts, src/server/routes/books.ts]
issue: 357
source: spec-review
date: 2026-03-13
---
Spec review caught that the test plan included a "blacklist service failure" error isolation case for the deduplicated search loop, but none of the four in-scope call sites (`runSearchJob`, `searchAllWanted`, `searchAndGrabForBook`, `triggerImmediateSearch`) use `BlacklistService`. Blacklist filtering exists in other flows (search route, RSS job, retry-search service) but not in the extraction targets.

Root cause: The test plan's error isolation section was carried over from the initial elaboration which treated the entire search pipeline as one unit. After narrowing scope to four specific call sites, the test plan wasn't re-validated against the actual dependency surface of those call sites. When scope narrows, test plan rows must be re-checked against the new scope boundary.
