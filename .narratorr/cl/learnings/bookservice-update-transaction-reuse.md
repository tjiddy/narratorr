---
scope: [backend]
files: [src/server/services/refresh-scan.service.ts, src/server/services/book.service.ts]
issue: 444
date: 2026-04-09
---
`bookService.update()` already wraps narrator sync + book row update in a single `db.transaction()`. Instead of creating a standalone function that manages its own transaction and needs `db` injected, reuse `bookService.update()` with both audio fields and `narrators` in one call. This eliminates the need to pass `db` through route deps and avoids duplicating transaction logic. The key insight: `Partial<NewBook>` includes all audio columns, so audio field updates fit naturally into the existing update path.
