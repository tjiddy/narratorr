---
scope: [frontend]
files: [src/client/pages/settings/GeneralSettingsForm.tsx, src/shared/schemas/settings/registry.ts]
issue: 157
date: 2026-03-27
---
`UpdateSettingsInput` is typed as `{ [K in SettingsCategory]?: Partial<AppSettings[K]> }` — each category field is a partial. So form submissions sending only a subset of fields (e.g., `{logLevel, housekeepingRetentionDays, recycleRetentionDays}` without `welcomeSeen`) are type-safe WITHOUT a cast. The old `data as AppSettings['general']` cast was hiding a type mismatch (form data was missing the new field). Remove the cast when adding new fields to a settings category — TypeScript will enforce the partial contract cleanly.
