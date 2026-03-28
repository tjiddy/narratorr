---
scope: [backend]
files: [src/server/services/health-check.service.test.ts]
issue: 279
date: 2026-03-10
---
Boundary tests using `Date.now() - threshold` are inherently flaky — by the time the service checks `Date.now()`, milliseconds have passed making "exactly at boundary" tests unreliable. Add a small buffer (e.g., 1 second) to the test setup time to account for execution time between creation and comparison.
