---
scope: [backend, services]
files: [src/server/services/import-adapters/manual.ts, src/server/utils/paths.ts]
issue: 650
date: 2026-04-18
---
When wiring `renameFilesWithTemplate` into the Manual Import adapter, the raw `bookRow` from `db.select().from(books)` lacks narrator data — narrators live in a junction table and are only available via `BookService.getById()`. The author source is `payload.authorName` from the persisted job metadata, not from `extractImportMetadata().bookInput` (which only contains `narrators`, `duration`, `coverUrl`). The eslint complexity limit (15) for `process()` was already near the boundary; the rename block pushed it to 27, requiring extraction into a private `renameIfConfigured` method.
