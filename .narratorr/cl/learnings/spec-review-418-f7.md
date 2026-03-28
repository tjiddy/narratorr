---
scope: [scope/backend]
files: []
issue: 418
source: spec-review
date: 2026-03-17
---
Reviewer caught that the test plan introduced a behavior change (rejecting unknown settings keys) while the spec framed this as a pure refactor. The gap: when adding test plan items for a newly-in-scope surface (settings schema), I assumed stricter validation without checking the current Zod schema behavior (`z.object()` strips unknown keys by default). Should have verified current behavior before writing test expectations, especially when the spec explicitly says "no behavior changes".
