---
scope: [backend]
files: [src/shared/schemas/settings/quality.ts, src/shared/schemas/settings/registry.ts, src/server/services/search-pipeline.ts]
issue: 30
date: 2026-03-20
---
Changing a settings default requires updating TWO places: the Zod schema `.default()` AND `DEFAULT_SETTINGS` in `registry.ts`. `SettingsService` returns `DEFAULT_SETTINGS[key]` for missing rows (not the Zod default), so only updating `quality.ts` leaves fresh installs and the settings UI reading the old value. Always grep for `DEFAULT_SETTINGS` when changing a schema default.
