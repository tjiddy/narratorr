---
scope: [scope/backend, scope/api]
files: [src/server/routes/discover.test.ts]
issue: 408
source: review
date: 2026-03-17
---
The refresh route test didn't verify warnings passthrough in the response body. When a service returns a new field (warnings array), the route test must assert the field survives serialization. Otherwise the route could silently drop warnings without any test failing.
