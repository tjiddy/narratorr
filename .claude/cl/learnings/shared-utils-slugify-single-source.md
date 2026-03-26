---
scope: [frontend, backend, core]
files: [src/shared/utils.ts, src/core/utils/parse.ts, src/client/pages/library-import/useLibraryImport.ts]
issue: 133
date: 2026-03-26
---
When a utility function (like `slugify`) needs to be used on both client and server, place it in `src/shared/utils.ts` and re-export from server-side modules. Without this, client-side slug-duplicate recheck can diverge from server-side slug generation, causing false negatives in duplicate detection. Re-export with `export { slugify } from '../../shared/utils.js'` — don't copy the implementation.
