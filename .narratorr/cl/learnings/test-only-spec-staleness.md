---
scope: [frontend]
files: [src/client/pages/manual-import/useManualImport.test.ts, src/client/pages/library-import/useLibraryImport.test.ts, src/client/components/manual-import/BookEditModal.test.tsx]
issue: 185
date: 2026-03-28
---
Test-only issue specs go stale fast — the original spec listed 6 already-covered behaviors as gaps. Always verify existing test files line-by-line before writing a test coverage spec, not just check for file existence. The spec review process caught this across 3 rounds, which could have been avoided by running `grep` for existing test descriptions against each AC item upfront.
