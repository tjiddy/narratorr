---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx, src/client/pages/library/StatusDropdown.tsx]
issue: 563
date: 2026-04-15
---
Library status filter is a `StatusDropdown` (not buttons). To select a status in tests: first click the trigger via `getByRole('button', { name: /all/i })`, then click `getByRole('option', { name: /wanted/i })`. The clear search button uses `aria-label="Clear search"` — prefer `getByLabelText('Clear search')` over fragile DOM traversal.
