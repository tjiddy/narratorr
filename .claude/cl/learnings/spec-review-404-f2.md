---
scope: [scope/backend]
files: []
issue: 404
source: spec-review
date: 2026-03-17
---
Reviewer noted the test plan lacked explicit assertions for AC3's query string format and AC4's scoring precedence. The auto-generated test plan covered the happy path but didn't include spy/assertion-level detail for the two most mechanically testable ACs. When writing test plans for "already implemented" issues, prioritize direct verification of the exact interface contracts (query args, scoring order) over behavioral descriptions.
