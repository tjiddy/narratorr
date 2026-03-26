---
scope: [backend, services]
files: [src/server/services/merge.service.ts]
issue: 112
date: 2026-03-26
---
TypeScript doesn't narrow nullable properties after a null guard. If `book.path` is `string | null` and you guard with `if (!book.path) throw ...`, later references to `book.path` still type-check as `string | null`. Extract to a local `const bookPath = book.path` after the guard — TypeScript narrows the local variable correctly. This is a standard TS narrowing limitation for object properties (they can be mutated between the check and the use, so TypeScript conservatively keeps the wide type).
