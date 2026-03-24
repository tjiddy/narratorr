---
scope: [backend, services]
files: [src/server/services/settings.service.ts, src/shared/schemas/settings]
issue: 360
date: 2026-03-14
---
All settings category schemas in Narratorr are flat `z.object({...})` — no nesting. This means `{ ...existing, ...incoming }` shallow merge is sufficient for per-category deep-merge in `SettingsService.update()`. If nested settings are ever added, this will need to change to a recursive merge. The spec review caught two rounds of wrong field names in test scenarios because the schemas weren't read first.
