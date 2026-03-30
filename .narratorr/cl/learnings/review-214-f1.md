---
scope: [backend, db]
files: [src/server/services/recycling-bin.service.ts]
issue: 214
source: review
date: 2026-03-30
---
When wrapping multi-step operations in transactions, any irreversible side effects (filesystem moves) that happen BEFORE the transaction need compensating actions if the transaction fails. The spec noted "filesystem move stays outside transaction" but didn't address what happens when the transaction fails afterward — the recycling entry becomes unretryable because files are at the wrong path. Fix: add a catch block that moves files back to recyclePath on transaction failure.
