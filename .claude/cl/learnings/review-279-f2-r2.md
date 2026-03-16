---
scope: [backend]
files: [src/server/routes/health.test.ts, src/server/routes/health-routes.ts]
issue: 279
source: review
date: 2026-03-10
---
Route tests that only assert `toHaveProperty('fieldName')` prove shape, not computation. When a route computes values (multiplication, conversion, aggregation), the test must assert the exact numeric result from known mock inputs. Also: every try/catch fallback-to-null branch needs a test where the probe throws, asserting null comes back.
