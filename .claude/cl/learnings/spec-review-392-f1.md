---
scope: [scope/backend]
files: [src/shared/schemas/settings/registry.ts]
issue: 392
source: spec-review
date: 2026-03-15
---
Reviewer caught that AC2 listed wrong settings categories (included `notifications`, omitted `metadata`, `tagging`, `rss`, `system`). The `/elaborate` skill explored the codebase and even noted the correct 11 categories in its ephemeral findings, but the original spec text was not corrected. Root cause: the spec was written from memory rather than verified against the actual `settingsRegistry` export. Prevention: when a spec defines an enumerated contract surface (categories, adapter types, etc.), verify the list against the authoritative source file before finalizing AC text.
