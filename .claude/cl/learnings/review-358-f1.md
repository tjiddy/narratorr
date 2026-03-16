---
scope: [frontend]
files: [src/client/pages/settings/SearchSettingsSection.test.tsx]
issue: 358
source: review
date: 2026-03-14
---
When resolving merge conflicts in test files, the "stashed" version may be missing validation coverage that the "upstream" version had. Taking one side of a conflict wholesale can silently drop test coverage for unrelated validation logic (numeric min/max, field rejection). Always diff the resolved test file against both conflict sides to verify no assertions were lost, especially for forms with Zod validation.
