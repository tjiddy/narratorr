---
scope: [backend]
files: [src/server/services/indexer.service.ts, src/server/services/indexer.service.test.ts]
issue: 372
source: review
date: 2026-04-06
---
Reviewer caught that preSearchRefresh() class-change persistence and same-class no-write branches had no direct assertions. The existing tests proved Mouse skip and error fallback but never exercised the non-Mouse class-change path. When adding a multi-branch helper, write at least one test per branch outcome — especially for DB persistence vs. no-write conditions.
