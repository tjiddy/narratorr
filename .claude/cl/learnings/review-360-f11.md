---
scope: [backend, services]
files: [src/server/services/import.service.ts, src/server/services/import.service.test.ts]
issue: 360
source: review
date: 2026-03-14
---
When a function has multiple catch blocks at different stages (success path vs failure-revert path), testing only the success-path catch leaves the failure-revert catch uncovered. The reviewer correctly identified that the import failure-revert SSE catch at line 448 was never exercised. Need separate tests for each catch block — force a failure at the right point in the flow to trigger each one independently.
