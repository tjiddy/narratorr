---
scope: [frontend]
files: [src/shared/schemas/settings/strip-defaults.ts, src/client/pages/settings/ImportSettingsSection.tsx]
issue: 295
date: 2026-04-02
---
`stripDefaults()` returns `z.object(Record<string, z.ZodType>)` which makes `z.infer<>` return `Record<string, unknown>`. This means `watch('fieldName')` returns `unknown` and requires a cast (e.g., `as boolean`). ProcessingSettingsSection avoids this by defining its form schema inline with explicit typed fields instead of using `stripDefaults()`. When using `stripDefaults`, expect to need type assertions on `watch()` results.
