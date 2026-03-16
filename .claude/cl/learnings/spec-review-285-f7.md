---
scope: [scope/backend, scope/api]
files: [src/server/routes/crud-routes.ts]
issue: 285
source: spec-review
date: 2026-03-11
---
Test plan introduced a preview endpoint that wasn't defined anywhere in the AC or system behaviors. Test plans should only test committed endpoints. Fix: if /elaborate adds test cases for a route not in the AC, it should promote the route to the AC first with a concrete behavior contract.
