---
scope: [frontend]
files: [src/client/components/Pagination.tsx, src/client/pages/activity/ActivityPage.test.tsx]
issue: 414
date: 2026-04-08
---
The `Pagination` component returns `null` when `total <= limit` (Pagination.tsx:12). Tests asserting page labels via `getAllByText(/Page \d+ of \d+/)` must account for pagination disappearing from the DOM when total shrinks below the page size. This changes the index of remaining pagination elements — e.g., queue pagination vanishes and history's moves to index 0.
