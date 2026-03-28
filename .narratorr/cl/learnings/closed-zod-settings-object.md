---
scope: [backend, core]
files: [src/shared/schemas/indexer.ts, src/shared/indexer-registry.ts]
issue: 264
date: 2026-03-08
---
`createIndexerFormSchema.settings` is a closed Zod `z.object({...})` — new indexer types that need additional settings fields (like `mamId`, `baseUrl`) must extend this object shape directly. The type propagates automatically to `INDEXER_REGISTRY` default settings and `settingsFromIndexer` via `CreateIndexerFormData['settings']`.
