---
scope: [backend, frontend]
files: [src/shared/schemas/settings/create-mock-settings.ts, src/server/__tests__/helpers.ts]
issue: 118
date: 2026-03-25
---
`createMockSettings(overrides)` and `createMockSettingsService(overrides)` use a `deepMerge(DEFAULT_SETTINGS, overrides)` pattern. Tests that use these factories automatically inherit new registry defaults without any changes — only tests that inline the full settings object (bypassing the factory) need updating when a new field is added to a schema. This halves the actual blast radius: mocked services via `createMockSettingsService()` are safe; explicit `settings.set('import', {...})` calls and `toEqual` assertions on the full object shape are the real targets.
