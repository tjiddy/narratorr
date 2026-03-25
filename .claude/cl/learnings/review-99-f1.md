---
scope: [scope/frontend]
files: [src/client/pages/search/SearchResults.test.tsx, src/client/pages/search/SearchPage.test.tsx]
issue: 99
source: review
date: 2026-03-25
---
Negating specific text strings is not enough to prove a blank state. When a component returns `null`, the correct assertion pattern is: (1) negate the expected-absent text AND (2) assert `container.querySelector('svg') === null` (no icon nodes). A test that only checks `queryByText('Start your search').not.toBeInTheDocument()` passes even if a partially-removed empty state renders a different title, icon, or wrapper div. The fix: always pair text-absence assertions with `container.querySelector('svg')` or `container.querySelector('[role="img"]')` checks when verifying blank-state renders.
