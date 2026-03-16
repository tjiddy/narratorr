---
scope: [scope/frontend]
files: [src/server/services/settings.service.ts]
issue: 341
source: spec-review
date: 2026-03-11
---
Spec assumed `SettingsService.set()` merges individual fields within a category, but it actually upserts the entire category value. This means sending `{ general: { logLevel: 'debug' } }` would reset `housekeepingRetentionDays` and `recycleRetentionDays` to schema defaults. The round 1 fix correctly switched to partial category payloads but didn't read `set()` deeply enough to understand the category-level granularity. Fix: when a spec describes save behavior, `/elaborate` should read the full storage path (route → service → DB operation) to verify the merge granularity, not just the API input type.
