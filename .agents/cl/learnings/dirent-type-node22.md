---
scope: [backend]
files: [src/server/utils/import-helpers.test.ts]
issue: 361
date: 2026-03-16
---
Node.js 22+ changed `Dirent` to be generic (`Dirent<NonSharedBuffer>`). In tests that mock `readdir` results, casting mock objects `as Dirent[]` causes TypeScript errors. Use `as never` instead to bypass the type mismatch, or define the mock helper without a return type annotation and let TypeScript infer it.
