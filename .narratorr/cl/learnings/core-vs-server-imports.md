---
scope: [core, backend]
files: [src/core/import-lists/abs-provider.ts, src/core/import-lists/hardcover-provider.ts, src/core/import-lists/nyt-provider.ts, src/server/utils/error-message.ts]
issue: 147
date: 2026-03-27
---
`src/core/` cannot import from `src/server/` — it's a layer violation. When a core adapter needs safe error message extraction, inline the `instanceof Error ? error.message : 'Unknown error'` pattern directly rather than importing `getErrorMessage()`. The `getErrorMessage()` helper is server-layer only; core adapters must be self-contained.
