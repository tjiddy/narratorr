---
scope: [backend, core]
files: [src/core/metadata/types.ts, src/core/metadata/audible.ts, src/server/services/metadata.service.ts]
issue: 229
date: 2026-03-30
---
Changing a provider interface return type (e.g., `BookMetadata[]` → `SearchBooksResult`) has a blast radius that includes both external callers (MetadataService methods) and internal callers within the provider itself (Audible's `searchAuthors`/`searchSeries` call `this.searchBooks()`). The spec review caught this twice — first for MetadataService consumers, then for AudibleProvider internal callers. Always enumerate ALL callers of a changed interface method, including self-calls.
