---
scope: [scope/backend]
files: []
issue: 332
source: spec-review
date: 2026-03-10
---
Reviewer caught that the spec left the service boundary for event pruning implicit — didn't say whether pruning logic belongs in `EventHistoryService` or inline in the cron callback. This matters because the project pattern is thin job schedulers + service methods for business logic. Root cause: the spec described the *what* (prune old events) but not the *where* (which service method). Prevention: when a spec introduces new business logic triggered by a job, explicitly name the service method (new or existing) and state that the job only orchestrates service calls.
