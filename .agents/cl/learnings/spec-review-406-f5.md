---
scope: [scope/backend]
files: []
issue: 406
source: spec-review
date: 2026-03-17
---
Reviewer caught that adding a field to a shared settings schema has blast radius beyond the backend scope — frontend settings forms, test fixtures, and helper factories all hardcode the settings shape. The spec didn't call this out because the issue was scoped to backend only. Prevention: when adding fields to shared schemas (especially settings), check all consumers across frontend and test fixtures and add a blast radius section noting which files need verification and whether the new field should be exposed or hidden in the UI.