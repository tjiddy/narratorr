---
scope: [scope/backend, scope/services]
files: []
issue: 435
source: spec-review
date: 2026-03-18
---
Reviewer caught a phantom production caller in the caller matrix — `getQualityGateData()` was listed as called by `GET /api/activity/:id` but the route actually only returns the raw download without quality gate data. Only the batch version (`getQualityGateDataBatch()`) has a production caller. Root cause: the caller matrix was drafted from method names and assumptions, not verified with `rg` against the actual route file. Prevention: always verify caller claims with grep before writing caller matrices.
