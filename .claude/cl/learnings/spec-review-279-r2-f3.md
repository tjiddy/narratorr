---
scope: [scope/backend, scope/api]
files: []
issue: 279
source: spec-review
date: 2026-03-10
---
Spec said health-run "returns current results or queues" — two mutually exclusive behaviors in one sentence. When specifying concurrency, pick exactly one observable behavior (e.g., "returns cached results with 200" vs "returns 409" vs "enqueues and returns 202"). "X or Y" in a spec is untestable.
