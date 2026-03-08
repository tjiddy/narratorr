---
scope: [scope/frontend, scope/backend]
files: [src/shared/schemas/indexer.ts, src/shared/indexer-registry.ts, src/client/components/settings/IndexerCard.tsx]
issue: 264
source: spec-review
date: 2026-03-08
---
AC7 listed wiring points for a new indexer type but omitted the form settings Zod schema shape (`createIndexerFormSchema.settings`). This is a closed object type, not a record — adding new settings keys (mamId, baseUrl) requires extending the shape definition, not just adding to enums/registries. The schema shape propagates to `CreateIndexerFormData['settings']` which types `INDEXER_REGISTRY.defaultSettings` and `settingsFromIndexer`. When specifying wiring for typed-settings features, always check whether the type shape itself needs extension, not just enum values.
