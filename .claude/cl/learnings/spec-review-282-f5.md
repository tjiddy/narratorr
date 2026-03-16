---
scope: [scope/frontend, scope/services]
files: [src/server/services/quality-gate.service.ts]
issue: 282
source: spec-review
date: 2026-03-10
---
Spec said narrator filter should split on `/,&;` but QualityGateService only splits on `[,;&]` (no forward slash). When referencing existing code behavior in a spec, read the actual source to verify the implementation rather than guessing from memory. The elaboration step introduced this error by stating the wrong delimiter set.
