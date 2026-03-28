---
scope: [scope/backend, scope/api]
files: [src/server/routes/settings.test.ts]
issue: 157
source: review
date: 2026-03-27
---
Route tests had no coverage for the new welcomeSeen field. PUT /api/settings accepted it but no test verified the field round-trips.

Why: Route tests for housekeeping fields were added but no analogous block was added for welcomeSeen.

What would have prevented it: When a new field is added to a settings category, add a route-level round-trip test. Pattern: mock service.update to return updated value, PUT the new field, verify 200 + correct body + service called with right args.
