---
scope: [frontend]
files: [src/client/components/manual-import/BookEditModal.tsx, src/client/hooks/useAudnexusSearch.ts]
issue: 97
date: 2026-03-26
---
`useAudnexusSearch` initializes `searchResults` state from the `initialResults` option, which in `BookEditModal` is built from the `alternatives` prop (+ `initial.metadata`). This means passing `alternatives` directly seeds `searchResults` with no API call required. For slice-boundary tests, you can drive 6 or 7 items via the `alternatives` prop instead of mocking `searchMetadata` — cleaner and faster than the search-flow approach.
