---
scope: [infra]
files: [e2e/tests/critical-path/search-grab-import.spec.ts]
issue: 614
source: review
date: 2026-04-17
---
Spec said the user-visible outcome was "same book card now renders with imported status" on `/library`, but the test used `/library` only as a navigation hop before asserting on book detail. A regression in the library-page books query or card rendering would have passed. Lesson: when a spec names a specific surface as the user-visible outcome, assert on that surface directly even if other surfaces redundantly reflect the state. One assertion per named outcome, not "whichever surface is easiest to read."
