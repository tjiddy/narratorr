---
scope: [backend]
files: [apps/narratorr/src/server/routes/books.ts]
issue: 257
source: review
date: 2026-03-05
---
When logging request params after Zod schema migration, `request.params` is the full params object `{ id: ... }`, not a scalar. Logging it directly as `bookId` produces `{ bookId: { id: "123" } }` instead of `{ bookId: "123" }`. Always destructure or cast to extract the scalar field.
