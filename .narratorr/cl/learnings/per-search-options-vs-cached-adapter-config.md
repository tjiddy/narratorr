---
scope: [backend, core]
files: [src/core/indexers/types.ts, src/core/indexers/myanonamouse.ts, src/server/services/indexer.service.ts]
issue: 386
date: 2026-04-07
---
When a setting needs to affect adapter behavior but the adapter is cached (constructed once from per-indexer config), inject the value via per-search options rather than reconstructing the adapter. `SearchOptions` is the natural extension point — `IndexerService` reads settings per-call and injects into options, avoiding cache invalidation complexity. Adapters that don't need the new option simply ignore it (optional field).
