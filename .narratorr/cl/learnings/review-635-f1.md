---
scope: [frontend]
files: [src/client/pages/book/BookDetails.tsx, src/client/pages/library/LibraryBookCard.tsx, src/client/pages/library/LibraryGridView.tsx, src/client/pages/library/LibraryPage.tsx]
issue: 635
source: review
date: 2026-04-17
---
Adding optional props to leaf components (BookHero, BookContextMenu) without wiring them from parent components creates dead UI that only appears in isolated tests. The spec named the leaf files but not the parent wiring chain (BookDetails → BookHero, LibraryPage → LibraryGridView → LibraryBookCard → BookContextMenu). When adding a new action prop, trace the entire render chain from page root to leaf and wire at every level.
