---
scope: [scope/backend, scope/services]
files: []
issue: 411
source: spec-review
date: 2026-03-16
---
Reviewer caught that AC1 used "deep-merges" while scope boundaries said "no recursive deep-merge" — contradictory wording. Root cause: used generic terminology ("deep-merge") when the actual operation is a flat category-level spread. Prevention: use precise merge terminology that matches the actual implementation — "flat merge" / "shallow merge over flat schema" when categories don't nest, reserve "deep-merge" for recursive object merging.
