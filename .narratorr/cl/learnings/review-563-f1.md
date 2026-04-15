---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx]
issue: 563
source: review
date: 2026-04-15
---
When testing clear/reset interactions, asserting only on DOM content (books reappearing) is insufficient. Must also assert the input value is empty and that the API was called with the cleared param (`search: undefined`). A cached TanStack Query result can render correct content from stale data even if the clear didn't properly propagate to API params.
