---
scope: [scope/backend, scope/api]
files: [src/server/routes/auth.ts, src/server/routes/auth.test.ts]
issue: 8
source: review
date: 2026-03-19
---
Every catch block with multiple branches must have a test for each branch. `DELETE /api/auth/credentials` had a two-branch catch (NoCredentialsError → 404, other → 500) but only the 404 branch was tested. When a route catch block discriminates error types, write one test per error type. The 500 path is especially important: if error mapping breaks, silent 500s ship to production.
