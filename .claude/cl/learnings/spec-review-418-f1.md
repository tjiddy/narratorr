---
scope: [scope/backend, scope/frontend, scope/services]
files: []
issue: 418
source: spec-review
date: 2026-03-17
---
Reviewer caught that the spec claimed "8 locations" but only enumerated 6 concrete files. The count-based reference made it impossible to verify completeness. Root cause: I stated a count without cross-checking it against the actual bullet list. Prevention: when a spec references a count of affected files, always verify the count matches the enumerated list, and prefer explicit numbered lists over count-based references.