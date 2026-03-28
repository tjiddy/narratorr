---
scope: [scope/backend, scope/core]
files: [src/core/metadata/audible.ts, src/core/metadata/types.ts]
issue: 437
source: spec-review
date: 2026-03-18
---
Reviewer caught that the spec claimed "eliminates all stub implementations" but AudibleProvider.getSeries() still returns null. The distinction matters: cross-provider stubs (methods on one provider that belong to the other's interface) are the ISP problem. Within-provider capability gaps (a method correctly assigned to a provider that the underlying API doesn't support yet) are a different issue. Root cause: used absolute language ("all stubs") without checking every method on the resulting interfaces. Prevention: when claiming a refactor eliminates stubs, verify each method on each resulting interface has a real (non-null/non-empty) implementation, and explicitly call out any that don't.
