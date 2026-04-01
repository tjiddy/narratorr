---
scope: [backend]
files: [src/server/services/search-pipeline.ts]
issue: 272
date: 2026-04-01
---
canonicalCompare in search-pipeline.ts is the canonical search result ranking function (manual search, auto-search, RSS, retry). rankResults in match-job.service.ts is a different function for metadata-match ranking. New search ranking features (grabs, language) belong in canonicalCompare, not rankResults. The spec initially pointed at the wrong function — always verify the actual caller surface before implementing.
