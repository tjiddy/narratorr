---
scope: [backend]
files: [src/server/services/import-list.service.ts]
issue: 482
date: 2026-04-12
---
When converting a null-returning find-or-create to a throwing variant, the try/catch scope must wrap only the author resolution + junction insert — not the entire `processItem`. Catching too high would skip `bookEvents` insertion and success logging for an already-inserted book. The spec review caught this gap; the fix was wrapping only lines 211-215 (findOrCreateAuthor + bookAuthors insert).
