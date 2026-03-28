---
scope: [scope/backend, scope/services]
files: []
issue: 436
source: spec-review
date: 2026-03-17
---
Round 1 fix moved enrichment outside ImportService as a "fatal side effect" in the orchestrator, but enrichment's rollback path only exists inside `importDownload()`'s catch block. The spec didn't verify that the proposed post-extraction failure contract was actually implementable with the current method signatures. Before proposing that a fatal operation moves outside its current error-handling boundary, trace the rollback path end-to-end and confirm the receiving layer can actually invoke it.
