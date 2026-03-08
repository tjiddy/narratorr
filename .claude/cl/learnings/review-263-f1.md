---
scope: [scope/backend]
files: [src/server/routes/settings.ts, src/server/routes/settings.test.ts]
issue: 263
source: review
date: 2026-03-08
---
Reviewer caught missing negative-path test for conditional cache invalidation. The route had `if (data.network && indexerService) { clearAdapterCache() }` but only the positive path (network settings → cache cleared) was tested. The negative path (non-network settings → cache NOT cleared) was missing, meaning a regression that clears cache on every save would go undetected.

Prevention: When adding conditional side effects (if X then do Y), always write both the positive test (X present → Y happens) and the negative test (X absent → Y does not happen). No-op placeholder tests claiming "verified elsewhere" don't count as coverage.
