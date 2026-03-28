---
scope: [scope/backend]
files: []
issue: 408
source: spec-review
date: 2026-03-17
---
The spec said "expiry failure should not fail refresh" without defining the partial failure contract — what `refreshSuggestions()` returns, what the route returns, and what gets logged. The existing return shape `{ added, removed, warnings }` already had a `warnings` array, so the contract was straightforward to define but was never stated. Root cause: non-functional requirements (error handling, partial failure) were described in the test plan but not elevated to an explicit service contract section. Would have been caught by requiring a "Failure Modes" or "Partial Failure Contract" section for any spec that introduces error isolation requirements.