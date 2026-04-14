---
scope: [backend]
files: [src/server/__tests__/helpers.ts]
issue: 554
date: 2026-04-14
---
The test helper `createMockDb()` mocks `db.transaction()` by passing the same mock `db` as the `tx` handle. This means tests cannot distinguish root `db` from `tx` by reference equality. To verify operation ordering (e.g., enrichment runs after transaction commit), use call-order tracking arrays instead of argument identity checks.
