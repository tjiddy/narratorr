---
scope: [backend, frontend]
files: [src/server/services/library-scan.service.ts, src/client/components/manual-import/BookEditModal.test.tsx]
issue: 114
date: 2026-03-25
---
When adding a required field to a shared interface (like `isDuplicate: boolean` on `DiscoveredBook`), every code path that constructs that type must be updated — including rarely-touched helper methods like `getBookDetails()` (single-book import path) and test factory functions in component test files. A `pnpm typecheck` run catches all constructor sites; grep for `DiscoveredBook` to find them proactively.
