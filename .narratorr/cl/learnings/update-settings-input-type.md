---
scope: [backend, services]
files: [src/server/services/settings.service.ts, src/server/routes/settings.ts, src/shared/schemas/settings/registry.ts]
issue: 411
date: 2026-03-16
---
`UpdateSettingsInput` (partial within categories) already existed in registry.ts but wasn't used by the service or route — both used `Partial<AppSettings>` (full category values required). When fixing type contracts, trace every surface that uses the type: service method signature, route body declaration, and test assertions. The existing `updateSettingsSchema` validation was already correct — only the TypeScript types were lying.
