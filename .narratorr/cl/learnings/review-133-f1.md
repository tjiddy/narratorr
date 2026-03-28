---
scope: [frontend]
files: [src/client/pages/library-import/useLibraryImport.ts, src/client/pages/library-import/LibraryImportPage.tsx]
issue: 133
source: review
date: 2026-03-26
---
When a hook (useMatchJob) exposes an error field, the consumer hook (useLibraryImport) must explicitly read and surface it — not just use isMatching. A match-job failure drops isMatching to false, which was silently re-enabling the Register button. Always thread error states up through the full hook→page chain, not just the "in-progress" boolean. The corresponding page test must also cover the failure → disabled button path (not just the happy path).
