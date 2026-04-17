---
scope: [backend, services]
files: [src/server/services/import-orchestration.helpers.ts, src/server/utils/import-side-effects.ts]
issue: 618
date: 2026-04-17
---
Manual imports have no `downloadId`, so the existing `emitImportSuccess`/`emitImportFailure` helpers from `import-side-effects.ts` cannot be reused directly — they emit `download_status_change` and `import_complete` which both require `download_id`. For manual imports, use `safeEmit` directly with `book_status_change` only. This also means activity/eventHistory live refresh is not triggered (those caches only invalidate on `import_complete`).
