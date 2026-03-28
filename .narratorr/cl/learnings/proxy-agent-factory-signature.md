---
scope: [backend, core]
files: [src/core/indexers/registry.ts, src/server/services/indexer.service.ts]
issue: 263
date: 2026-03-08
---
When adding a parameter to adapter factory functions in `registry.ts`, all existing tests that spy on `createAdapter` need their assertions updated to include the new argument (even when it's `undefined`). Vitest's `toHaveBeenCalledWith` is strict about argument count.
