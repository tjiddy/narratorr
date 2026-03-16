---
scope: [scope/api]
files: [src/server/routes/import-lists.ts, src/server/routes/import-lists.test.ts]
issue: 285
source: review
date: 2026-03-12
---
When adding a new route endpoint in a fix commit, it needs its own route-level integration tests — even if the frontend component tests mock the API call. Route tests catch wiring, serialization, and error-mapping regressions that frontend mocks cannot. The ABS library-fetch proxy route was added without inject() tests, leaving the 400/502 error mappings unverified.
