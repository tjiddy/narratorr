---
scope: [scope/services, scope/backend]
files: [src/server/services/book-list.service.ts, src/shared/schemas/book.ts]
issue: 397
source: review
date: 2026-03-16
---
AC3 said "derive SortField and SortDirection from shared schemas" but implementation only derived SortField — SortDirection was still locally defined as `'asc' | 'desc'`. The shared schema had `sortDirection` inline in `bookListQuerySchema` without its own named type, so there was nothing to import. The fix required extracting `bookSortDirectionSchema` as a named export first, then importing the derived type. When an AC says "derive from shared schema" and the shared schema doesn't yet have a named export, the implementation must create the named export first.
