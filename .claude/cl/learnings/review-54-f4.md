---
scope: [backend, services]
files: [src/server/services/download.service.ts, src/server/services/download.service.test.ts]
issue: 54
source: review
date: 2026-03-21
---
A service method that bulk-deletes with a `where(inArray(...getTerminalStatuses()))` predicate needs a test proving the filter fires — not just that the return count is correct. A test only checking `{ deleted: 3 }` still passes if the where clause is removed. Pattern: capture the chain with `const chain = mockDbChain(...)`, call the method, then assert `chain.where` was called once AND spy on `getTerminalStatuses` to prove the registry drives the filter.
