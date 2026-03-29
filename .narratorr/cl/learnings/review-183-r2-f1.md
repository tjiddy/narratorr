---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx]
issue: 183
source: review
date: 2026-03-29
---
When asserting navigation, use the exact expected path (e.g., `/books/4`), not a pattern match (`/books/\d+`). A pattern match proves the shape but not that the correct entity's ID was used. Determine the expected ID from the test data and default sort order, then hard-code it in the assertion.
