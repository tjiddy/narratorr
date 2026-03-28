---
scope: [scope/backend, scope/services]
files: []
issue: 436
source: spec-review
date: 2026-03-17
---
Reviewer caught that the approve path has two SSE emissions for the same transition (QGS emits pending_review→importing, then emitImportingStatus emits it again). The spec moved SSE to the orchestrator without addressing the duplication. Root cause: didn't trace the full event flow across service boundaries on each call path. Fix: when a spec moves event/notification responsibilities, trace each call path end-to-end and document ownership of each emission point, especially where multiple services touch the same status transition.