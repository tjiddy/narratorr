---
scope: [scope/backend]
files: []
issue: 406
source: spec-review
date: 2026-03-17
---
Reviewer caught that the spec mentioned concurrent refresh behavior in the test plan but never defined the concurrency model. The test plan bullet "Concurrent refresh cycles → second refresh reads latest dismissal data" was vague and didn't specify the guard mechanism. The spec missed this because the scheduled job already uses the task registry, but the manual refresh route (`POST /api/discover/refresh`) bypasses it entirely. Prevention: when a feature has multiple entry points (scheduled job + manual route), verify each entry point's concurrency path and specify the guard explicitly.