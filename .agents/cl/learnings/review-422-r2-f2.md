---
scope: [scope/backend]
files: [src/server/routes/event-history.test.ts]
issue: 422
source: review
date: 2026-03-17
---
Reviewer caught that the new DOWNLOAD_NOT_FOUND error code added to EventHistoryService had plugin-level and service-level tests but no route-level integration test proving the full service→plugin→route chain for that specific code. When adding a new typed error code, test coverage must span all three layers: service throws it, plugin maps it, and route returns the expected HTTP status.
