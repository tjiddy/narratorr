---
scope: [backend]
files: [src/server/services/health-check.service.test.ts]
issue: 279
source: review
date: 2026-03-10
---
When a service has a derived/aggregate method (like getAggregateState()) that other components depend on, it needs its own unit tests exercising the precedence logic — not just indirect coverage through the route layer mocking it. The route test mocking getAggregateState() proves the route delegates; it doesn't prove the method itself is correct.
