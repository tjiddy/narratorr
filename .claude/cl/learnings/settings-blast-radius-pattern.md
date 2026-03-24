---
scope: [backend, frontend]
files: [src/shared/schemas/settings/general.ts, src/shared/schemas/settings/registry.ts]
issue: 332
date: 2026-03-10
---
Adding a field to any settings category has a wide blast radius across test files. Tests that hardcode `general: { logLevel: 'info' }` break with strict `toEqual`. The fix pattern: grep for the category name in test files and add the new field. `createMockSettings()` auto-inherits from `DEFAULT_SETTINGS`, but inline fixtures in component test wrappers and route tests don't. Check both `toEqual` assertions AND form `defaultValues` wrappers.
