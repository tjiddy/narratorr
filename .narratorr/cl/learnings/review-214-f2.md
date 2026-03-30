---
scope: [backend, db]
files: [src/server/services/recycling-bin.service.test.ts]
issue: 214
source: review
date: 2026-03-30
---
When testing that a function passes a transaction handle through to callees, using `expect.anything()` for the tx argument is vacuous if the mock `transaction()` returns the same `db` object. A regression from `syncAuthors(tx, ...)` to `syncAuthors(this.db, ...)` would still pass. Fix: create a distinct tx mock via `mockImplementationOnce` and assert exact object identity (`expect(mock).toHaveBeenCalledWith(txMock, ...)`).
