---
scope: [backend]
files: [src/server/services/metadata.service.ts, src/server/services/blacklist.service.ts]
issue: 497
date: 2026-04-12
---
`BlacklistService` established the pattern for optional `SettingsService` injection: third constructor param, typed as `SettingsService` from `settings.service.ts`, optional so the service works without it (backwards-compatible). When adding settings access to a service, follow this pattern — wiring happens in `routes/index.ts` where the `settings` instance is already available.
