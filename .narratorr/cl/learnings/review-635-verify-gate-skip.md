---
scope: [frontend, backend]
files: [src/client/pages/library/LibraryBookCard.tsx, src/client/pages/library/LibraryBookCard.test.tsx]
issue: 635
source: review
date: 2026-04-17
---
Adding a hook that calls `useQuery` to a component breaks all existing tests that render without `QueryClientProvider`. In round 3 of PR #644, `useRetryImportAvailable` was added to `LibraryBookCard` but `LibraryBookCard.test.tsx` was not updated — 68 tests broke. The root cause was skipping `scripts/verify.ts` and substituting targeted test runs for the full suite. Targeted runs only covered new/changed test files, missing the blast radius on existing tests. **Process fix: never push during /respond-to-pr-review without running the full verify gate. No exceptions, no shortcuts.**
