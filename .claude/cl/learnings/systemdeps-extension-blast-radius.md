---
scope: [scope/backend]
files: [src/server/services/health-check.service.ts, src/server/services/health-check.service.test.ts]
issue: 437
date: 2026-03-18
---
Adding a field to the SystemDeps interface on HealthCheckService breaks the test fixture in health-check.service.test.ts because createService() constructs the deps object inline. When extending injected dependency interfaces, always check the test factory/fixture that constructs the mock — TypeScript will catch the type error but only if you run typecheck before committing. This is the same "fixture blast radius" pattern documented for settings schemas.
