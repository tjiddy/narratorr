---
scope: [backend, services]
files: [src/server/jobs/enrichment.ts, src/server/jobs/enrichment.test.ts]
issue: 398
date: 2026-04-07
---
Expanding the `db.select()` query in enrichment.ts from 2 fields to 8 fields broke all 20 existing tests that mocked `mockDbChain([{ duration: null, genres: null }])` because `book.title` became undefined (causing `.toUpperCase()` to throw). When expanding a select query, ALL existing test mocks returning that shape need updating. Use `replace_all` to batch-fix them efficiently.
