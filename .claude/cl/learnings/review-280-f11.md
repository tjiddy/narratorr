---
scope: [scope/backend, scope/api]
files: [src/server/routes/system.ts]
issue: 280
source: review
date: 2026-03-10
---
The restore confirm route's success branch (triggers backup swap + server restart) was untested. Prevention: routes that trigger process-level side effects (restart, shutdown) still need tests asserting the service call and response, even if the side effect is mocked.
