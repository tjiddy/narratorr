---
scope: [scope/frontend]
files: []
issue: 5
source: spec-review
date: 2026-03-19
---
When adding route-level test plan items in spec review response, assumed `POST` for the password-change endpoint without checking the actual route registration. The route is `PUT /api/auth/password` (auth.ts:124). Always verify HTTP methods against route source before adding route-level test plan items — don't assume POST for mutations.
