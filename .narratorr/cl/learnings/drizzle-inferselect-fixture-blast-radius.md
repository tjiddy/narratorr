---
scope: [db, backend]
files: [src/server/__tests__/factories.ts, src/server/services/quality-gate.service.test.ts]
issue: 274
date: 2026-04-01
---
Adding columns to a Drizzle schema table widens `$inferSelect`, breaking any inline book fixture that doesn't use the factory's `...overrides` pattern. The `createMockDbBook()` factory auto-adapts (spread pattern), but hardcoded fixtures like `quality-gate.service.test.ts:baseBook` must be updated manually. Always grep for inline fixtures when adding DB columns.
