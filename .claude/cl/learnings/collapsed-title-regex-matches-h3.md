---
scope: [frontend]
files: [src/client/pages/library/LibraryBookCard.tsx, src/client/pages/library/LibraryBookCard.test.tsx]
issue: 105
date: 2026-03-25
---
When a collapsed card now shows `book.seriesName` in the title h3, a test asserting `queryByText(/The Stormlight Archive/)` will match the h3 **and** fail as a "not in document" assertion — because the very text you hid in the hover section now appears in the title. Use the series-position-specific string (`'The Stormlight Archive #1'`) to uniquely target the hover-section series label in tests, since the title never includes the position suffix.
