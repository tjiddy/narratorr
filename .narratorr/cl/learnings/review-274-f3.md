---
scope: [scope/frontend]
files: [src/client/pages/book/useBookActions.test.ts]
issue: 274
source: review
date: 2026-04-01
---
**What was caught:** The `wrongReleaseMutation` success tests only asserted toast behavior and API call, but did not test that `queryClient.invalidateQueries` was called for all three query keys (book, bookFiles, books). If the invalidation block were deleted, tests would still pass and the UI would stay stale.

**Why we missed it:** The test stubs from `/plan` only had "invalidates book query on success" but the existing pattern in the same file (merge, rename, monitor) always includes a dedicated `invalidateQueries` spy assertion. The sibling pattern wasn't followed.

**What would have prevented it:** When writing hook tests for mutations that call `invalidateBookQueries()`, always check sibling mutations in the same file for their invalidation test pattern and replicate it.
