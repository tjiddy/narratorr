---
scope: [backend, db]
files: [src/server/__tests__/helpers.ts]
issue: 214
date: 2026-03-30
---
When mocking `db.transaction()` for Drizzle, the simplest approach is `db.transaction.mockImplementation(async (cb) => cb(db))` — execute the callback with the same mock db as `tx`. This means all operations inside the transaction go through the same stubs, making assertion setup identical to non-transactional tests. For testing tx isolation (proving `tx` is used instead of `this.db`), create a separate `createMockDb()` as the tx and verify the original `db` stubs were NOT called.
