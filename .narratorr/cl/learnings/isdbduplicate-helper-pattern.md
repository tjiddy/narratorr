---
scope: [frontend]
files: [src/client/pages/library-import/useLibraryImport.ts, src/client/pages/library-import/LibraryImportPage.tsx]
issue: 342
date: 2026-04-04
---
When adding a new enum variant that splits existing boolean behavior (e.g., `isDuplicate` now has DB vs within-scan semantics), introduce a helper predicate (`isDbDuplicate`) to avoid scattering the check across 10+ call sites. The helper centralizes the logic and prevents drift between surfaces. The LibraryImportPage also needed its own local `isDbDup` closure because it operates on rows, not bare books.
