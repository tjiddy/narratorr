---
scope: [scope/backend, scope/services]
files: []
issue: 436
source: spec-review
date: 2026-03-17
---
Reviewer noted the "may need restructuring" test note was too vague for a 7-suite blast radius. Root cause: treated test impact as an afterthought rather than a first-class spec section. Fix: for refactor specs, enumerate every affected test suite with expected impact (what changes, what stays) in the test plan.