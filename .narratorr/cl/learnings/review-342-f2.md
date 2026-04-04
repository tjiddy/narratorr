---
scope: [frontend]
files: [src/client/pages/library-import/useLibraryImport.test.ts]
issue: 342
source: review
date: 2026-04-04
---
When modifying a retry/re-filter path (e.g., `handleRetryMatch` filter), the existing retry test may only exercise the default fixture which has no within-scan rows. A new fixture with the new row type must be used to prove the filter change works. The pattern: for each filter change, verify the filter output contains the newly-included type AND still excludes the previously-excluded type.
