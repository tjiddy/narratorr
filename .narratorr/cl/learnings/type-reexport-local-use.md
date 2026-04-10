---
scope: [frontend, backend]
files: [src/client/lib/api/search.ts, src/client/lib/api/library-scan.ts]
issue: 409
date: 2026-04-10
---
`export type { Foo } from './bar.js'` re-exports the type but does NOT make it available for local use in the same file. If the file also references `Foo` in its own interfaces/types, you need a separate `import type { Foo } from './bar.js'` alongside the re-export. This caused a TS2304 error during SearchResult unification that was easily caught by typecheck but would have been avoidable by knowing the pattern upfront.
