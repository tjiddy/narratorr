---
scope: [scope/backend, scope/db]
files: []
issue: 366
source: spec-review
date: 2026-03-16
---
Reviewer caught that the stale-suggestion lifecycle was left undefined — the test plan literally said "either kept or cleaned up (define behavior)". Gap: `/elaborate` added this as a test plan item but marked it as "define behavior" instead of actually defining it. When `/elaborate` fills test plan gaps, it must resolve every ambiguity — leaving "define behavior" placeholders in the spec is the same as leaving the gap unfilled.
