---
scope: [frontend]
files: [src/client/lib/api/api-contracts.test.ts]
issue: 26
date: 2026-03-20
---
api-contracts.test.ts has TWO separate locations that reference each API module: a dedicated describe block for that module's methods, and a "response pass-through" describe block with one representative test per API. When deleting an API module, both locations must be cleaned up — just removing the named describe block leaves the pass-through test orphaned. Grep for the module name across the entire test file, not just the describe block title.
