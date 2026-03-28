---
scope: [frontend, backend]
files: [src/shared/download-status-registry.ts, src/shared/download-status-registry.test.ts]
issue: 41
date: 2026-03-20
---
The handoff coverage review does an exhaustive scan of ALL behaviors in changed source files, not just the delta. When a file is touched (even a single field change), every function in that file — including pre-existing ones — gets flagged if untested. `getClientPolledStatuses()` was flagged untested in a display-only label rename. Adding the test was trivial (2 assertions) but added a commit loop. Worth doing a quick grep for untested exports in any file you touch to pre-empt the coverage review flag.
