---
scope: [scope/frontend]
files: [src/client/pages/library/useLibraryFilters.ts, src/client/pages/library/LibraryToolbar.tsx, src/client/pages/library/LibraryActions.tsx]
issue: 364
source: spec-review
date: 2026-03-14
---
Spec proposed extracting a `useLibraryFilters()` context/reducer when one already existed. Also incorrectly included `LibraryActions` as a filter/sort consumer when it only receives action callbacks. Root cause: `/elaborate` didn't read the actual component source to verify what state was already centralized and which children actually consumed filter/sort values vs. action props. The fix descriptions and AC were based on the debt scan summary, not verified against current code.
