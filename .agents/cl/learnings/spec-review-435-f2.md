---
scope: [scope/backend, scope/services]
files: []
issue: 435
source: spec-review
date: 2026-03-18
---
Reviewer caught that the post-extraction API surface was undefined — the spec said "returns a decision" but never specified method signatures, visibility changes, or return types. Without an explicit method table, implementers can't place DB transitions consistently. Root cause: the spec described the extraction goal directionally ("move X out") without pinning down the resulting interface contract. Prevention: for extraction/refactoring specs, always include a post-extraction API surface table with method names, visibility, return types, and responsibilities.
