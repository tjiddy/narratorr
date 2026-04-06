---
scope: [backend]
files: [src/server/services/book-list.service.test.ts]
issue: 365
source: review
date: 2026-04-06
---
When removing one clause from an OR condition, the test must assert both the removal AND the survival of the remaining clauses. A "no narrator" assertion alone wouldn't catch accidental deletion of series/genres/author. Always test both sides of a removal: what's gone AND what's retained.
