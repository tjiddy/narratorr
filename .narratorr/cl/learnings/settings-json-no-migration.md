---
scope: [backend]
files: [src/shared/schemas/settings/library.ts, src/shared/schemas/settings/registry.ts]
issue: 210
date: 2026-03-29
---
Settings categories use a generic JSON `value` column in the DB, not per-field columns. Adding new fields to a settings schema does NOT require a Drizzle migration. Zod parse with `.default()` fills missing fields on read. This caused initial confusion (spec referenced migration requirement that was incorrect). Always verify persistence model before assuming migration is needed.
