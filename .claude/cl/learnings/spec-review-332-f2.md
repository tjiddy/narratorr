---
scope: [scope/backend]
files: []
issue: 332
source: spec-review
date: 2026-03-10
---
Reviewer flagged that adding a field to the `general` settings category would break 16+ test files that hardcode settings fixtures. The spec didn't mention blast radius for test fixtures. Root cause: settings schema changes have a wide blast radius in this codebase because test fixtures spread full settings objects — but the spec template doesn't prompt for test fixture impact analysis. Prevention: when a spec adds/modifies a settings field, include a blast-radius note listing affected test fixture patterns (e.g., "all tests hardcoding `general` payloads need the new field").
