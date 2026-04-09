---
scope: [backend]
files: [src/server/services/match-job.service.ts, src/server/utils/search-helpers.ts]
issue: 447
date: 2026-04-09
---
When `searchWithSwapRetry` fires, downstream ranking and similarity checks still use the original (misparsed) context. Switching to `searchWithSwapRetryTrace` and creating a swapped `MatchCandidate` context is the minimal-blast-radius fix — it avoids changing helper signatures or affecting other callers like `library-scan.service.ts`. The trace variant already existed as prior art from the scan-debug endpoint.
