---
scope: [scope/frontend]
files: [src/client/lib/api/books.ts, src/client/lib/api/search.ts, src/client/lib/api/import-lists.ts]
issue: 364
source: spec-review
date: 2026-03-14
---
AC suggested composite keys using fields (`guid`, singular `author`) that don't exist on the actual types (BookMetadata has `authors[]` array, no `guid`; SearchResult has no `guid`). Root cause: elaboration proposed key strategies without reading the type definitions. When specifying composite key strategies, always verify field names exist on the actual interfaces.
