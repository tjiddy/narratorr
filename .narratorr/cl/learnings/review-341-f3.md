---
scope: [backend]
files: [src/shared/schemas/event-history.test.ts]
issue: 341
source: review
date: 2026-04-04
---
Adding a new enum value to a shared Zod schema requires a direct schema-level test (parse positive + parse negative), not just indirect coverage through service/route tests. The plan step should always include "update schema test file" when touching shared schema enums — it's easy to miss because the code compiles and route tests pass without it.
