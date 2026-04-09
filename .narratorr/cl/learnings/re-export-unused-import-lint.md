---
scope: [backend]
files: [src/server/services/library-scan.service.ts]
issue: 446
date: 2026-04-09
---
When extracting functions from a file that re-exports them (`export { foo } from './new-module.js'`), do NOT also import them at the top of the same file (`import { foo } from './new-module.js'`) unless the file itself uses them. ESLint's `@typescript-eslint/no-unused-vars` catches the import as unused since `export { ... } from` is a standalone re-export that doesn't need a local binding. Use `export { ... } from` alone.
