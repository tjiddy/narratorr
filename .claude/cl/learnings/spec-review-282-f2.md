---
scope: [scope/frontend, scope/api]
files: []
issue: 282
source: spec-review
date: 2026-03-10
---
Bulk search spec assumed a selected-book search endpoint existed but only global search-all-wanted and per-book search existed. When speccing bulk operations, verify which single-item endpoints exist and define the fan-out strategy explicitly rather than assuming batch endpoints will be created.
