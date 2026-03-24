---
scope: [scope/services, scope/backend]
files: []
issue: 418
source: spec-review
date: 2026-03-17
---
Reviewer caught that AC3 claimed "no hardcoded reason string literals remain in production code" while the spec explicitly kept service-layer reason-specific switch/weight logic out of scope. The gap: when narrowing a refactor's goal in the description/scope section, the AC wording wasn't updated to match. AC language must be precise enough to be satisfiable given the stated scope boundaries — if scope carves something out, ACs cannot claim it's eliminated.
