---
scope: [scope/backend, scope/services]
files: [src/server/jobs/enrichment.ts]
issue: 398
source: review
date: 2026-04-07
---
Reviewer caught that `isAllCaps(book.title) && result.title` is not enough for a title-update guard — if the enrichment provider returns the same ALL-CAPS string, we'd still write a no-op update and increment the counter. Root cause: spec said "overwrite when ALL CAPS" but implementation didn't add a same-value check. Fix: add `result.title !== book.title` to the guard. Preventable by adding a same-value no-op test case during red-phase TDD — any conditional overwrite should test the identity case.
