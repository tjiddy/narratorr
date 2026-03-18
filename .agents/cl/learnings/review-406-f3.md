---
scope: [scope/services, scope/backend]
files: [src/server/services/discovery.service.ts, src/server/services/discovery.service.test.ts]
issue: 406
source: review
date: 2026-03-17
---
Reviewer caught that resurfaced snoozed rows were never tested with non-default multipliers. All refresh integration tests used default (all 1.0) multipliers, so if the multiplier argument was accidentally dropped from the resurfacing path, every test would still pass. When adding a parameter that threads through multiple code paths (fresh candidates + resurfaced rows), test every path that receives it — not just the primary one. The spec explicitly called this out as AC5 ("apply on next refresh cycle only") which includes resurfaced rows.
