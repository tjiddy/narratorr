---
scope: [scope/backend, scope/services]
files: [src/server/services/discovery.service.test.ts]
issue: 408
source: review
date: 2026-03-17
---
getSuggestions() had no test for the new snooze visibility filter. The existing tests only covered "returns rows" and "returns empty" without exercising the snoozeUntil WHERE clause. When adding a WHERE filter to an existing query, always add a test specifically for the new filter branch.
