---
scope: [scope/backend, scope/services]
files: []
issue: 418
source: spec-review
date: 2026-03-17
---
Reviewer caught that the headline goal "add a new reason in one place" was contradicted by explicitly leaving service-layer reason-specific logic (switch statement, weight values) out of scope. Root cause: the issue description's motivating sentence was aspirational rather than precise — it described the ideal end state, not what this specific refactor delivers. Prevention: when writing the issue description's goal statement, verify it is achievable within the stated scope boundaries. If out-of-scope items prevent the goal, either expand scope or narrow the goal language.