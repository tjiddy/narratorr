---
scope: [backend]
files: [src/server/services/match-job.service.ts, src/server/services/match-job.service.test.ts]
issue: 335
date: 2026-04-04
---
When changing a threshold constant that existing tests implicitly rely on (e.g., DURATION_THRESHOLD from 5% to tiered), existing tests may break not because the new logic is wrong but because the test fixture's combined score now qualifies for the relaxed threshold. Fix by updating existing tests to use low-score candidates that stay on the strict path — don't just add new tests and assume existing ones still pass.
