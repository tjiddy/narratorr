---
scope: [backend, services]
files: [src/server/services/backup.service.ts, src/server/services/backup.service.test.ts]
issue: 359
source: review
date: 2026-03-15
---
When extracting logic from a route handler into a service method, the route-level tests that previously tested the logic end up mocking the new service method — leaving the extracted logic untested. Must add service-level tests that exercise the real implementation when doing extract-to-service refactors.
