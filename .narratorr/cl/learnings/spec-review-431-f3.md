---
scope: [scope/backend]
files: [src/server/routes/auth.ts, src/server/routes/auth.test.ts]
issue: 431
source: spec-review
date: 2026-03-17
---
Reviewer caught that the test plan specified InvalidPasswordError -> 401, but the actual codebase uses "Current password is incorrect" -> 400. The 401 path is login's "Invalid credentials", not the password-change flow. Prevention: always read existing test assertions for the exact HTTP status codes before writing test plan items for error class migrations.
