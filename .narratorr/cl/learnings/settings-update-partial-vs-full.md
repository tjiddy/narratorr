---
scope: [backend, api]
files: [src/server/services/settings.service.ts, src/server/routes/update.ts]
issue: 333
date: 2026-03-10
---
`SettingsService.update()` takes `Partial<AppSettings>` where each category value must be the FULL category object — it calls `set()` which overwrites the entire category. To update a single field within a category, you must `get()` the current value first, spread-merge the change, then `set()` the full object. The `UpdateSettingsInput` type (categories optional, fields partial within) exists for the Fastify body schema validation but the service doesn't deep-merge — it's a leaky abstraction.
