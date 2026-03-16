---
scope: [backend]
files: [src/server/routes/health.test.ts]
issue: 279
source: review
date: 2026-03-10
---
Route error handler tests must cover ALL status branches, not just the happy path and named error conditions. The catch-all 500 branch is the most likely to regress silently because it handles "everything else." When a route handler has if/else chains on error messages, each branch needs its own test case.
