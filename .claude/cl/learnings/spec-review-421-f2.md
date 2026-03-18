---
scope: [scope/frontend]
files: []
issue: 421
source: spec-review
date: 2026-03-17
---
AC3 included "validation" in coverage requirements without defining what validation means for the component. The component only uses native HTML constraints (`required`, `minLength`) with no JS-level validation — so "validation coverage" is ambiguous. Should have inspected the component's actual validation mechanism and specified the testable contract (attribute assertions vs behavioral blocking) in the test plan.
