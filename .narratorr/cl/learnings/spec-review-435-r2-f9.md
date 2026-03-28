---
scope: [scope/backend, scope/services]
files: []
issue: 435
source: spec-review
date: 2026-03-18
---
Reviewer caught that the orchestrator batch loop had no defined source for its input set. The API surface table defined all the decision/transition methods but forgot the query that feeds the loop. The established pattern (`ImportOrchestrator.processCompletedDownloads()` pulling from `ImportService.getEligibleDownloads()`) shows the batch-input seam must be explicit. Root cause: focused on extracting side effects out of `processCompletedDownloads()` but didn't consider that the query at the top of the method also needs a defined home. Prevention: for any extracted batch loop, explicitly define the batch-input method in the API surface table.
