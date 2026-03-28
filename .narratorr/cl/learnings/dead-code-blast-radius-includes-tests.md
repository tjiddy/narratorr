---
scope: [backend]
files: [src/server/services/book.service.ts, src/server/services/book.service.test.ts]
issue: 85
date: 2026-03-25
---
When a spec says a method "has zero callers (confirmed via grep)," the grep is checking production code only. Test files calling the method are also callers — deleting the method without deleting its test blocks causes compile errors. Always grep test files too (`git grep 'service\.search'` across `*.test.*`) before listing blast radius as "remove 10 lines." In this issue, `BookService.search()` had 2 separate `describe('search', ...)` test blocks (lines 643–663 and 789–814) that had to be co-deleted.
