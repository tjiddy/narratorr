---
scope: [scope/frontend]
files: [src/shared/schemas/settings/registry.ts, src/client/lib/api/settings.ts]
issue: 341
source: spec-review
date: 2026-03-11
---
Spec described a full-object merge save strategy for settings, but the API already accepts partial per-category payloads via `UpdateSettingsInput`. The elaborate step read the existing `BackupScheduleForm` which uses partial payloads, but the spec body (written earlier) still said "full settings object merged from cache." Root cause: the spec was written with an assumption about the API shape without verifying `UpdateSettingsInput` and the route schema. Fix: `/elaborate` test plan should verify the actual API contract shape (request type, route schema) before writing save-behavior test cases.
