---
scope: [backend]
files: [src/server/services/import-list.service.test.ts]
issue: 477
source: review
date: 2026-04-11
---
When testing multi-table insert flows (book → author → bookAuthors → bookEvents), asserting insert call counts or final log lines is not enough. Each insert chain from `mockReturnValueOnce` should have its `.values()` assertion checked for the exact payload (authorId, bookId, position, eventType). This catches wrong-ID bugs that count-based assertions miss. For null/skip paths, include a second item to prove the loop continues after the edge case.
