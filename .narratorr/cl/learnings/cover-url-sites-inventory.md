---
scope: [frontend]
files: [src/client/pages/library/LibraryBookCard.tsx, src/client/pages/book/BookHero.tsx, src/client/pages/book/BookDetails.tsx, src/client/pages/author/BookRow.tsx, src/client/components/manual-import/BookEditModal.tsx, src/client/components/book/BookMetadataModal.tsx]
issue: 418
date: 2026-04-08
---
Cover image render sites split into two categories: (1) library book covers that use local `/api/books/:id/cover` URLs and need cache-busting via `resolveCoverUrl` — LibraryBookCard, BookHero (2 img tags). (2) Metadata/search result covers that use external provider URLs (Audible, Audnexus) and use plain `resolveUrl` — BookRow, BookEditModal, BookMetadataModal. The distinction is the source type: `BookWithAuthor.coverUrl` is local, `BookMetadata.coverUrl` is external.
