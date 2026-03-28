---
scope: [backend]
files: [src/server/services/discovery.service.ts, src/server/services/discovery.service.test.ts]
issue: 404
date: 2026-03-17
---
When testing series-specific behavior in `generateCandidates`, remember that `queryAuthorCandidates` runs BEFORE `querySeriesCandidates`. If a book matches both author and series queries, the dedup map keeps whichever scores higher. This means: (1) filter assertions by `reason === 'series'` not just by ASIN, and (2) when testing series multiplier floors, also floor the author multiplier or the author score will win the dedup and the candidate's reason will be 'author' not 'series'.
