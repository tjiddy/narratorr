---
scope: [scope/backend, scope/services]
files: []
issue: 436
source: spec-review
date: 2026-03-17
---
Reviewer caught that the caller matrix for the approve route oversimplified the call to just `orchestrator.importDownload(id)`, omitting the existing `tryAcquireSlot()` / `setProcessingQueued()` / `releaseSlot()` concurrency branch that wraps the import call. The spec had already declared concurrency stays on ImportService (AC1) but the caller matrix contradicted this by showing a direct orchestrator call without the slot-acquisition gate.

Root cause: when updating the caller matrix in round 2, I focused on which object the import call targets (orchestrator vs service) without tracing the full route handler logic. The approve route does more than just call importDownload — it has a concurrency branch that gates whether the import fires immediately or queues.

Prevention: when writing caller matrices, read the full route handler and list every service method called in sequence, not just the "main" call. A caller matrix entry should show the complete call flow, not just the import entry point.
