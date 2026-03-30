---
scope: [backend, db]
files: [src/db/client.ts, src/server/services/book.service.ts]
issue: 214
date: 2026-03-30
---
Drizzle's `db.transaction()` callback receives `SQLiteTransaction`, not the `LibSQLDatabase` type (`Db`). The transaction object lacks `batch()` which `Db` has. Need a `DbOrTx = Db | Transaction` union type for helpers that accept both. Extract `Transaction` from `Parameters<Parameters<Db['transaction']>[0]>[0]` to stay DRY with the actual Drizzle types.
