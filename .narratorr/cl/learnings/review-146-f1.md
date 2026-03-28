---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.tsx, src/client/pages/library/LibraryBookCard.tsx]
issue: 146
source: review
date: 2026-03-26
---
Extracting useCallback handlers to eliminate inline closures in .map() only works if the card component's prop signatures don't still require the parent to pass wrapper closures. When the handler needs book-scoped data (bookId, the full book object), shift that scope into the card component: update its prop signatures to accept the handler directly (e.g., `onMenuToggle: (id: number, e) => void`) and have the card pass its own book.id/book when calling the handler. The parent can then pass stable handler references with no wrappers, and React.memo can prevent sibling card re-renders from unrelated parent state changes.
