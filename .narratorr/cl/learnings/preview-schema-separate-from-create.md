---
scope: [backend, api]
files: [src/server/routes/import-lists.ts, src/shared/schemas/import-list.ts]
issue: 285
date: 2026-03-11
---
Preview/test-config endpoints that accept unsaved configuration need their own Zod schema (just `type` + `settings`), NOT the full create schema. The create schema requires `name`, `enabled`, `syncIntervalMinutes` which preview doesn't need. Reusing create schema causes 400 validation errors from the frontend which only sends the fields it needs. Self-review caught this — route test was masking the bug by sending the full payload.
