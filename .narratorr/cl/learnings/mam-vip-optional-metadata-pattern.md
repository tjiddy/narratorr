---
scope: [backend, core]
files: [src/core/indexers/types.ts, src/server/routes/crud-routes.ts, src/server/services/indexer.service.ts]
issue: 317
date: 2026-04-03
---
When extending a shared adapter interface (IndexerAdapter.test()) with adapter-specific data, use an optional `metadata?: Record<string, unknown>` bag rather than adding typed fields. This keeps the interface generic — non-MAM adapters don't need to change. The service layer checks for specific keys (`'isVip' in result.metadata`) before persisting. Thread the metadata through every layer (core → service → route → client type) or it gets silently dropped.
