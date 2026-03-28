---
scope: [frontend]
files: [src/client/pages/library-import/useLibraryImport.test.ts]
issue: 185
source: review
date: 2026-03-28
---
Retry tests that only assert re-invocation (call count) are vacuous for offset-reset behavior. The stale-offset bug this tests for (prevMatchCountRef not reset) would cause `matchResults.slice(oldOffset)` to skip results, but a call-count test can't detect that. Tests must drive the full match→retry→match cycle and assert observable row state changes (e.g., edited title or confidence) to prove the offset is reset. This applies to any ref-based cursor pattern.
