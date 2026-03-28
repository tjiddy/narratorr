---
scope: [scope/backend, scope/core]
files: [src/core/metadata/types.ts, src/core/metadata/audible.ts]
issue: 437
source: spec-review
date: 2026-03-18
---
Reviewer caught that renaming a forced null-return from "stub" to "capability gap" didn't resolve the ISP problem. If no current implementation can meaningfully fulfill a method, it shouldn't be required on the interface — that's the entire point of ISP. The fix was to remove getSeries() from MetadataSearchProvider and return null at the service boundary instead. Root cause: tried to defend keeping the method on the interface by reframing the problem instead of actually fixing it. Prevention: when a reviewer says a method shouldn't be required because no implementation supports it, the correct response is to remove it from the interface, not to argue about terminology.
