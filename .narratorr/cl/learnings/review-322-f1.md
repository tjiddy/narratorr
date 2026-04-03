---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx]
issue: 322
source: review
date: 2026-04-03
---
Integration tests asserting prop wiring must verify the exact value, not just that a value exists. `expect.stringContaining('/search?q=')` would pass with any hard-coded non-empty query. Decode the param and assert the exact input value. Self-review and coverage subagent both caught the missing test but not the weak assertion.