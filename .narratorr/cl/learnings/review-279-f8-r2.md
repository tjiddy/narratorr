---
scope: [backend]
files: [src/server/services/health-check.service.test.ts]
issue: 279
source: review
date: 2026-03-10
---
When code uses nullish coalescing for fallback (`progressUpdatedAt ?? addedAt`), the null/fallback branch needs its own test with null input and an old fallback value. Also: any DB query wrapped in try/catch needs a test where the query rejects, asserting the error result shape and message propagation.
