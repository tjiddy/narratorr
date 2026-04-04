---
scope: [scope/backend, scope/services]
files: [src/server/services/library-scan.service.test.ts]
issue: 341
source: review
date: 2026-04-04
---
Reviewer caught that `confirmImport()` lacked a multi-author regression test for the joined-author `book_added` payload, even though `importSingleBook()` had one. When fixing a production code pattern (F2: use `book.authors` instead of `item.authorName`), the corresponding test was only added for one of the two callers. The gap: when a code fix applies to multiple call sites, each call site needs its own regression test — not just the first one fixed.
