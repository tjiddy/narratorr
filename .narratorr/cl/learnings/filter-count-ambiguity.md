---
scope: [frontend]
files: [src/client/pages/library/LibraryToolbar.test.tsx]
issue: 351
date: 2026-03-14
---
Adding new status pills with numeric counts creates ambiguity in tests that use `screen.getByText('2')` for the active filter badge. When the same number appears both as a status pill count and a filter badge count, use a more specific selector like `within(filtersButton).getByText('3')` with a unique count value. Avoid asserting on common numbers like 1 or 2 that are likely to appear in multiple status pill counts.
