---
scope: [scope/backend, scope/frontend]
files: [src/shared/schemas/settings/registry.ts, src/client/pages/settings/SettingsLayout.tsx, src/client/App.tsx]
issue: 430
source: spec-review
date: 2026-03-18
---
Reviewer caught that settingsRegistry (schema categories) was conflated with settings pages (routed UI surfaces). The spec said "derive App.tsx routes from registry keys" but GeneralSettings groups 9 schema categories into one page, and CRUD pages (Indexers, Download Clients, etc.) aren't in the schema registry at all. Root cause: /elaborate accepted the original spec's assumption that schema categories map 1:1 to pages without reading GeneralSettings.tsx to verify. Would have been caught by reading the actual page components during elaboration, not just the registry.
