---
scope: [backend, services]
files: [src/server/services/import-adapters/manual.ts]
issue: 650
source: review
date: 2026-04-18
---
The reviewer caught that `renameIfConfigured()` re-read `settingsService.get('library')` instead of reusing the snapshot that `copyToLibrary` uses internally. This creates a timing-dependent divergence where folder placement and file renaming could use different naming settings if the user changes settings mid-import. The auto-import path (`import.service.ts:105-121`) snapshots settings once at the top — the manual adapter should follow the same pattern. The spec's AC code snippet showed `settingsService.get('library')` inside the method, which I followed literally without considering the single-snapshot pattern.
