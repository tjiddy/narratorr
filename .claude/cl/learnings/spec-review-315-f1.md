---
scope: [scope/backend, scope/services]
files: [src/server/services/prowlarr-sync.service.ts]
issue: 315
source: spec-review
date: 2026-03-11
---
Spec for secret encryption missed that ProwlarrSyncService writes indexer apiKeys directly to the DB (bypassing IndexerService) and stores its own apiKey in the settings table. The elaboration step didn't trace all write paths for secret fields — it focused on the obvious CRUD services. Lesson: when a spec touches a cross-cutting concern (encryption, logging, auth), grep for ALL write paths to the affected DB columns, not just the primary service.
