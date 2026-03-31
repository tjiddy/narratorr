---
scope: [backend, core]
files: [src/core/metadata/types.ts, src/server/services/metadata.service.ts, src/core/metadata/audible.ts]
issue: 235
date: 2026-03-31
---
Extending `SearchBooksOptions` with new fields is the cleanest way to add structured search without breaking the `MetadataSearchProvider` interface. The options parameter is already threaded through `MetadataService` → `AudibleProvider`, so adding `title?`/`author?` was purely additive. The `searchBooksForDiscovery` method already passes options, confirming this is the established relay pattern. Existing callers that don't pass the new fields get backward-compatible `keywords`-based search.
