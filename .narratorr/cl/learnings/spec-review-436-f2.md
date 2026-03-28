---
scope: [scope/backend, scope/services]
files: []
issue: 436
source: spec-review
date: 2026-03-17
---
Reviewer caught that the spec didn't name which callers switch to the orchestrator. The approve route and cron job both call ImportService directly today, and without a caller matrix, two implementers could wire them differently. Root cause: focused on what moves out of the service but didn't trace the inbound call graph. Fix: for any extraction/refactor spec, include a caller matrix listing every entry point and its pre/post call path.