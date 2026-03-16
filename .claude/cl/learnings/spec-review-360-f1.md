---
scope: [scope/backend, scope/services]
files: [src/server/services/settings.service.ts, src/server/routes/settings.ts]
issue: 360
source: spec-review
date: 2026-03-14
---
AC4 invented a new `update(category, partial)` API signature that didn't match the existing `update(partial: Partial<AppSettings>)` contract. The reviewer caught that this would force route, schema, and test changes the spec never mentioned. Root cause: wrote the AC describing the desired behavior change without reading the current function signature and its callers first. Should have read the actual `update()` method, the route that calls it, and the test that exercises it before specifying the API shape.
