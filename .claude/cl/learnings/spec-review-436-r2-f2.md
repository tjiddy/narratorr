---
scope: [scope/backend, scope/services]
files: []
issue: 436
source: spec-review
date: 2026-03-17
---
Round 1 fix added a caller matrix showing the orchestrator wrapping `processCompletedDownloads()`, but didn't verify that the wrapper could actually observe per-download failures — the method swallows them internally. When proposing an orchestrator/wrapper pattern over an existing method, check whether the method's return contract exposes the information the wrapper needs (failure details, per-item outcomes, etc.). If it doesn't, the wrapper design needs to change the call boundary, not just wrap it.
