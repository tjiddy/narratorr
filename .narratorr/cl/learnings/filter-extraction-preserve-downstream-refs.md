---
scope: [backend]
files: [src/server/services/search-pipeline.ts, src/core/utils/filters.ts]
issue: 540
date: 2026-04-13
---
When extracting inline code that declares a local variable, grep for all downstream references to that variable before deleting the declaration. In search-pipeline.ts, replacing the language filter block removed `const langs = ...` but `langs` was still used by `canonicalCompare()` 5 lines later. The fix was trivial (keep the declaration), but the test failure wasn't obvious — 48 unrelated tests failed with `ReferenceError: langs is not defined`. Scanning for downstream uses of any removed locals would have caught this before running tests.
