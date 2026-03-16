---
scope: [scope/backend, scope/services]
files: [src/server/services/metadata.service.ts]
issue: 366
source: review
date: 2026-03-16
---
The `withThrottledSearch` private method was shared between `search()` (which already accumulated warnings) and the new `searchBooksForDiscovery()`. The rate-limit branch correctly appended to warnings, but the generic catch branch only logged and returned empty. The spec contract said non-rate-limit failures should also surface via warnings. When reusing a shared internal method for a new public surface with different error contracts, verify ALL catch branches match the new contract.
