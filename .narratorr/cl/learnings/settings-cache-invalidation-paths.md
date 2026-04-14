---
scope: [backend]
files: [src/server/services/settings.service.ts]
issue: 554
date: 2026-04-14
---
SettingsService has multiple write paths that bypass `set()`: `migrateLanguageSettings()` does a direct `db.insert().onConflictDoUpdate()` for the quality blob cleanup. Any cache implementation must add explicit invalidation after ALL direct DB writes, not just those routed through `set()`/`patch()`. The `getAll()` aggregate cache also needs independent invalidation — callers like `update()` and `GET /api/settings` serve the aggregate directly.
