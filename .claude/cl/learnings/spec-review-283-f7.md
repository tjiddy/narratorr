---
scope: [scope/backend]
files: [src/server/services/download.service.ts]
issue: 283
source: spec-review
date: 2026-03-10
---
Spec listed `download.service.ts:markFailed()` as an emission site but the actual method is `setError()`. The round 1 elaboration explore agent likely inferred the method name from the behavior rather than reading the actual method signatures. Prevention: when listing specific method names in emission site enumerations, grep for exact method declarations rather than inferring names from behavior descriptions.
