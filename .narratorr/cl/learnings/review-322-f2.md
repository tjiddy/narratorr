---
scope: [frontend]
files: [src/client/pages/search/SearchPage.test.tsx]
issue: 322
source: review
date: 2026-04-03
---
When testing boundary conditions (e.g., query length < 2), assert all user-visible consequences — not just the absence of an API call. The disabled button state is a separate observable behavior from the suppressed API call. Missing it means a regression could enable the button while still suppressing auto-search, and the test would pass.