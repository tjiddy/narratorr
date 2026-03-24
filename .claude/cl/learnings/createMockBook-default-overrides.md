---
scope: [frontend]
files: [src/client/__tests__/factories.ts, src/client/pages/library/useLibraryFilters.test.ts]
issue: 312
date: 2026-03-08
---
When replacing a local factory (with null defaults) with `createMockBook` (which has rich defaults like `author: Brandon Sanderson`, `seriesName: The Stormlight Archive`), tests that relied on null/undefined author or series will break. Always null out factory defaults explicitly when the test requires "no author" or "no series" — e.g., `createMockBook({ author: undefined, seriesName: null })`.
