---
scope: [scope/services, scope/backend]
files: [src/shared/schemas/book.ts]
issue: 397
source: spec-review
date: 2026-03-15
---
Spec review caught that AC3 would have moved locally-defined SortField/SortDirection types into the new service, preserving DRY-1 (parallel types) debt. The shared schema already defines these types via Zod in `src/shared/schemas/book.ts`. When extracting code that defines local types, always check if a shared/canonical version already exists and derive from it instead of copying the local definition.
