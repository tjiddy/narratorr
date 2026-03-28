---
scope: [backend, services]
files: [src/server/services/settings.service.ts, src/shared/schemas.ts]
issue: 315
date: 2026-03-11
---
`SettingsCategory` (from `settingsRegistry` in shared/schemas.ts) does NOT include 'prowlarr' or 'auth' — those are stored in the settings TABLE but managed by their own dedicated services (ProwlarrSyncService, AuthService). The SettingsService only handles categories like library, search, network, etc. Mapping `Partial<Record<SettingsCategory, SecretEntity>>` with 'prowlarr'/'auth' keys causes a TypeScript error. Only 'network' is a valid secret-bearing SettingsCategory.
