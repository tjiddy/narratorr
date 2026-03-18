---
scope: [scope/backend, scope/services]
files: []
issue: 435
source: spec-review
date: 2026-03-18
---
Reviewer caught that `revertBookStatus` ownership was left as "needs design decision" in the spec. The existing DownloadOrchestrator already handles revertBookStatus at line 92, establishing the pattern. Root cause: treated the decision as novel when the pattern was already established in the codebase. Prevention: before flagging a design decision as unresolved, check existing orchestrators/services for the same pattern — if one exists, just follow it.
