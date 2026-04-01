---
scope: [backend]
files: [src/shared/schemas/settings/quality.ts, src/shared/schemas/settings/registry.ts]
issue: 272
date: 2026-04-01
---
New settings fields must be added in TWO places: (1) the Zod schema with `.default()` and (2) `settingsRegistry.*.defaults` / `DEFAULT_SETTINGS`. Runtime settings and createMockSettings() use DEFAULT_SETTINGS (not Zod parsing). Adding only to the schema causes the runtime default to be missing and mock factories to lack the field.
