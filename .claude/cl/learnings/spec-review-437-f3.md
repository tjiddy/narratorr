---
scope: [scope/frontend]
files: [src/client/pages/settings/CrudSettingsPage.tsx, src/client/pages/settings/IndexersSettings.tsx]
issue: 437
source: spec-review
date: 2026-03-18
---
Reviewer caught that the CRUD settings-page section was stale — CrudSettingsPage already exists and DownloadClientsSettings already uses it, but the spec described all three pages as copy-paste templates needing extraction. Also missed that IndexersSettings has a Prowlarr header action requiring the headerExtra prop. Root cause: spec was written from memory of an earlier codebase state without verifying current implementation. Prevention: for DRY refactor specs, always check which instances already use the target pattern before describing the extraction scope.
