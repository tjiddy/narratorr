---
scope: [scope/services, scope/backend]
files: [src/server/services/book.service.ts, src/server/services/book.service.test.ts]
issue: 79
source: review
date: 2026-03-24
---
Reviewer caught that extracting `syncAuthors`/`syncNarrators` into shared helpers broke the atomicity of `BookService.create()`. The book row is inserted first; if sync then fails, the book row is left orphaned with no authors.

Fix: wrap the post-insert sync calls in a try/catch that issues a compensating `db.delete(books).where(eq(books.id, bookId))` before re-throwing.

What let this slip: when extracting multi-step operations into helpers, atomicity analysis is easy to miss. The test only asserted the rejection, not whether the DB state was clean afterward. Rule: whenever a function inserts to table A then writes to table B, explicitly decide between (a) wrapping both in a transaction, or (b) adding a compensating delete — and write a test that verifies the orphan is cleaned up.
