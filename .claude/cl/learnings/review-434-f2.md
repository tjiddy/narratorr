---
scope: [scope/backend, scope/services]
files: [src/server/utils/download-side-effects.ts]
issue: 434
source: review
date: 2026-03-18
---
When creating fire-and-forget helper functions that catch errors internally, every helper needs a direct failure-path test — not just a representative sample. The initial implementation tested failure paths for 3 of 8 helpers, leaving 5 untested. If any of those helpers stops catching errors, the test suite still passes. Pattern: for each try/catch or .catch() in a helper, add a test that forces the failure path and asserts the error is swallowed + logged.
