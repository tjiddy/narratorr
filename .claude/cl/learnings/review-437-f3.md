---
scope: [scope/backend]
files: [src/server/services/health-check.service.ts, src/server/services/health-check.service.test.ts]
issue: 437
source: review
date: 2026-03-18
---
Reviewer caught that new public delegation methods (probeFfmpeg, probeProxy) on HealthCheckService had no direct service-level tests. The route tests mocked the service methods so they never exercised the real delegation. Prevention: when adding a new public method to a service that delegates to an injected dep, write a service-level test asserting the exact argument forwarding and return value/error propagation.
