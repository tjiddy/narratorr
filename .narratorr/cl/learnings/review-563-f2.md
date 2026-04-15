---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx]
issue: 563
source: review
date: 2026-04-15
---
When testing filter intersection (search + status), result-only assertions are vacuous if the fixture data already matches both filters by default. Always assert the API call args include both filter params (`search` AND `status`) to prove the intersection is being applied, not just that the fixture data happens to match.
