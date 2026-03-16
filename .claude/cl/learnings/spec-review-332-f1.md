---
scope: [scope/backend]
files: []
issue: 332
source: spec-review
date: 2026-03-10
---
Reviewer caught that the spec said "configurable via Settings" without pinning the exact settings path (`general.housekeepingRetentionDays`), Zod schema, registry default, or UI location. The AC was not pass/fail testable. Root cause: the spec was written at a higher level of abstraction than the codebase requires — the settings system is category-based with concrete nested paths, and any new field needs to name its category, key, schema shape, and UI surface explicitly. Prevention: when a spec adds a new setting, always pin: (1) category.fieldName, (2) Zod type with constraints, (3) registry default value, (4) which Settings page/section renders it.
