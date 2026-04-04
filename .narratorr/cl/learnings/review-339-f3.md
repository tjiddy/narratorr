---
scope: [backend, api]
files: [src/server/routes/crud-routes.ts, src/server/routes/indexers.test.ts]
issue: 339
source: review
date: 2026-04-04
---
When adding a new field to a route body schema with validation constraints (e.g., `z.number().int().positive().optional()`), always add a 400-path route integration test with invalid input (e.g., `id: -1`). The happy-path and absent-path tests don't exercise the schema's rejection behavior. Without this, a regression in the schema extension would silently route invalid values to the service.
