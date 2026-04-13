---
scope: [backend]
files: [src/server/services/import.service.ts, src/server/services/import.service.test.ts]
issue: 525
source: review
date: 2026-04-13
---
New DB-contract methods (query predicates, CAS updates) need direct service-level tests even when higher-level orchestrator tests exercise the methods through mocks. Mocking a service method proves the caller's behavior but not the callee's DB contract. The `/plan` step should flag new service methods that touch DB predicates as requiring their own test cases in the service test file, not just orchestrator-level coverage.
