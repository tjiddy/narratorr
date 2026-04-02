---
scope: [backend, frontend]
files: [src/core/indexers/registry.ts, src/client/components/settings/IndexerCard.tsx]
issue: 291
date: 2026-04-02
---
When extracting settings that have valid falsy values (searchType: 0 = "all torrents", searchLanguages: [] = "unrestricted"), use `??` (nullish coalesce) not `||` (logical or). `||` replaces 0, empty arrays, and empty strings with defaults — silently breaking user intent. This applies to every layer: factory, settingsFromIndexer, and adapter construction. The spec review caught this as a blocking finding before implementation.
