---
scope: [backend]
files: [src/server/services/library-scan.service.ts]
issue: 341
source: review
date: 2026-04-04
---
Library-scan callers used `item.authorName` (raw import item) for event payloads instead of `book.authors` (created book's full author list). The books route already used `book.authors?.map(a => a.name).join(', ')` correctly. When recording events after `bookService.create()`, always use the created book's populated relations — not the raw input — to get the canonical multi-author representation. A sibling pattern check during implementation would have caught this by comparing all 4 call sites against each other.
