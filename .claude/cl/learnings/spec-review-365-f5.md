---
scope: [scope/api, scope/backend]
files: [src/server/routes/health-routes.ts, src/server/routes/system.ts, src/client/lib/api/system.ts]
issue: 365
source: spec-review
date: 2026-03-15
---
Spec review caught that L-14's test plan pointed at `/api/health` (which only returns status/timestamp) instead of `/api/system/info` (where the hardcoded `'0.1.0'` actually lives). The AC was correct (fix the hardcoded version in health-routes.ts) but the test plan validated the wrong endpoint.

Root cause: `/elaborate` assumed the health route serves `/api/health`, but `health-routes.ts` actually serves `/api/system/info` while `system.ts` serves `/api/health`. The route-to-file mapping was guessed rather than verified.

Prevention: When writing test plans that assert HTTP endpoint behavior, always read the route file to confirm which URL path the route actually serves. Don't assume endpoint paths from file names.
