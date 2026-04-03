---
scope: [frontend]
files: [src/client/components/settings/IndexerCard.tsx]
issue: 317
source: review
date: 2026-04-03
---
`settingsFromIndexer()` explicitly lists every settings field to hydrate edit-mode forms. Adding a new persisted field (`isVip`) to the adapter/schema without also adding it to this hydration function silently drops it on save. The `/plan` step should grep for all settings-reconstruction sites when adding a new persisted field — `settingsFromIndexer` is not in the adapter or schema, so it's easy to miss.
