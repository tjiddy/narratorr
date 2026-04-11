---
scope: [backend]
files: [src/server/routes/books.ts, src/server/routes/books.test.ts]
issue: 466
source: review
date: 2026-04-11
---
When removing a route-local error handler that had a custom 500 body, the route test for unexpected errors must be updated to assert the new body from the global error handler plugin (`"Internal server error"`). Status-code-only assertions don't prove the contract change. This was called out as an intentional change in the PR body but lacked a test assertion.
