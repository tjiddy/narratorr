---
scope: [frontend]
files: [src/client/components/manual-import/ImportCard.tsx, src/client/components/manual-import/BookEditModal.tsx, src/client/components/manual-import/types.ts]
issue: 143
date: 2026-03-26
---
When extracting types out of a component file into a shared types.ts, you must also add a re-export from the original file. Test files that import types directly from the component file (not via the barrel) will silently break at typecheck time unless the original file re-exports from the new location. Pattern: add `export type { MyType } from './types.js'` to the source component file alongside `import type { MyType } from './types.js'` for the component's own use.
