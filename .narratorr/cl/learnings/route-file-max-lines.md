---
scope: [backend]
files: [src/server/routes/books.ts, src/server/routes/book-preview.ts]
issue: 320
date: 2026-04-03
---
`books.ts` was at 367 lines before this change — adding ~90 lines for the preview route exceeded the 400-line max-lines lint rule. When adding new endpoints to an existing route file near capacity, plan for extraction into a separate file from the start to avoid rework.
