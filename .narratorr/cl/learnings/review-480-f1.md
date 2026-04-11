---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx]
issue: 480
source: review
date: 2026-04-11
---
When an AC explicitly names a TanStack Query interaction (e.g., "isError takes precedence over stale placeholderData"), the test suite must exercise that exact transition — initial success followed by refetch failure — not just initial failure. The implementation plan's test stubs only covered initial-load scenarios; the refetch-after-success case was in the spec's test plan but wasn't stubbed. Should have created a stub for every distinct test plan scenario during `/plan`, not just the AC items.
