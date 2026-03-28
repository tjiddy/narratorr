---
scope: [backend, services]
files: [src/server/services/book.service.ts]
issue: 71
date: 2026-03-24
---
`getMonitoredBooks()` and `search()` in BookService now call `getById()` in a loop (N+1 queries) instead of joining. This was the correct tradeoff for the initial implementation — correctness first, then optimize. The `getAll()` path in BookListService already uses batch-load via `inArray(bookIds)` to avoid N+1. When the monitored/search lists are small (<100), the N+1 cost is negligible. Document this intentional tradeoff in the PR to avoid it looking like an oversight.
