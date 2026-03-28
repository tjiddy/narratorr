---
scope: [scope/backend, scope/services]
files: []
issue: 435
source: spec-review
date: 2026-03-18
---
Reviewer caught that the approve path has import-slot acquisition and `processing_queued` flow control that the spec didn't account for. The route does more than just call approve + dispatch side effects — it acquires concurrency slots and conditionally queues. Root cause: only read the service method, not the full route handler that calls it. Prevention: for any caller matrix entry, read the full calling code (not just the service method) to capture cross-service flow control that may need explicit ownership assignment.
