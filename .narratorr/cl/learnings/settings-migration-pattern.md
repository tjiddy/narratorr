---
scope: [backend]
files: [src/server/services/settings.service.ts, src/server/routes/index.ts]
issue: 386
date: 2026-04-07
---
For cross-category settings migrations (moving a field from one category to another), follow the `bootstrapProcessingDefaults()` pattern: add a method to SettingsService, call it from `createServices()` in routes/index.ts. Read raw DB blobs (bypassing Zod) to access legacy fields that the new schema would strip. Always check idempotency before writing (e.g., `Array.isArray(targetBlob.field)` → skip if already migrated). Wrap in try/catch to avoid blocking startup.
