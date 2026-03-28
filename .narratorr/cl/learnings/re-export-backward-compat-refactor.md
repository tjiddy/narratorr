---
scope: [backend, services]
files: [src/server/jobs/search.ts, src/server/services/search-pipeline.ts]
issue: 357
date: 2026-03-13
---
When extracting a function from one module to another, re-exporting it from the original module (`export { searchAndGrabForBook } from '../services/search-pipeline.js'`) prevents breakage in files that import from the original location. This is useful as a transitional step but can be cleaned up later. For types, `export type { ... }` preserves the type-only import constraint.
