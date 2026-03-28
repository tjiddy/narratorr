---
scope: [backend, services]
files: [src/server/utils/import-steps.ts, src/shared/schemas/settings/tagging.ts]
issue: 349
date: 2026-03-16
---
When extracting functions that call `TaggingService.tagBook()`, the `mode` parameter must use the `TagMode` union type from `src/shared/schemas/settings/index.js`, not plain `string`. TypeScript will catch this at typecheck but not at test time since mocks accept `as never`.
