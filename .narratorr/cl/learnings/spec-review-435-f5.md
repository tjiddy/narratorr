---
scope: [scope/backend, scope/services]
files: []
issue: 435
source: spec-review
date: 2026-03-18
---
Reviewer caught that the spec deferred shared orchestration pattern design even though issue comment 9773 explicitly says the first of #434/#435/#436 must define it. The DownloadOrchestrator and ImportOrchestrator already exist and establish the pattern — so it wasn't even deferred, it was already solved. Root cause: took the original issue's "proposed direction" at face value without checking if the pattern already existed. Prevention: when a spec says "defer pattern design", check if the pattern already exists in the codebase before marking it out of scope.
