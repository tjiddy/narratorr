---
scope: [scope/frontend]
files: [src/client/pages/library/StatusPills.test.tsx, src/client/pages/library/LibraryToolbar.test.tsx, src/client/pages/library/useLibraryFilters.test.ts]
issue: 351
source: spec-review
date: 2026-03-14
---
Reviewer caught that expanding a union type (`StatusFilter`) would break test fixtures in 3 files that hardcode `Record<StatusFilter, number>` with only 4 keys. The spec didn't enumerate affected test files.

Root cause: Didn't grep for all usages of the type being modified. When a spec changes a shared type, the scope boundaries should list every file that references it — especially test fixtures with hardcoded record literals.
