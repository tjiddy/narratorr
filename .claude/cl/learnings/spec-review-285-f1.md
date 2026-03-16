---
scope: [scope/backend, scope/db]
files: [src/shared/schemas/settings/registry.ts, src/db/schema.ts]
issue: 285
source: spec-review
date: 2026-03-11
---
Spec assumed import lists could reuse the existing `settings.import` category, but that category already handles post-download import behavior (deleteAfterImport, minSeedTime, minFreeSpaceGB). Elaborate skill built test plan around get+spread+set on settings.import without checking what that category actually contains. Fix: /elaborate should always check the actual contents of any settings category it references, and prefer dedicated tables for CRUD entities (following indexer/download-client/notifier pattern).
