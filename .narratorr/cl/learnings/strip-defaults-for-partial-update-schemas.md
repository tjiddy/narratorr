---
scope: [backend]
files: [src/shared/schemas/settings/registry.ts, src/shared/schemas/settings/strip-defaults.ts]
issue: 227
date: 2026-03-31
---
Zod's `.default()` fires during `.partial()` parsing — absent fields get their default value injected, not `undefined`. When building partial-update schemas (like PATCH endpoints), always apply `stripDefaults()` before `.partial()` to ensure omitted fields stay truly undefined. The existing `stripDefaults` utility was already used for form schemas but not for the API update schema.
