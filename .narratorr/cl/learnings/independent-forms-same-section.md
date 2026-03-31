---
scope: [frontend]
files: [src/client/pages/settings/LibrarySettingsSection.tsx]
issue: 265
date: 2026-03-31
---
When adding a second form to a settings section that already has a different save mechanism (e.g., blur-save), use completely independent `useForm` + `useMutation` hooks. The two forms share the same `useQuery` data source but maintain separate dirty state, reset behavior, and mutation calls. The partial `quality` update API (`api.updateSettings({ quality: { ... } })`) merges server-side via `SettingsService.update()`, so sending only 2 of 7 quality fields is safe — the other 5 are preserved.
