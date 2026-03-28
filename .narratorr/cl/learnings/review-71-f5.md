---
scope: [backend, services]
files: [src/server/services/book.service.ts, src/server/services/book.service.test.ts]
issue: 71
source: review
date: 2026-03-24
---
When an issue explicitly requires deduplication of authors AND narrators within a single payload, deduplicate both — not just authors. The PR deduplicated authors by slug in `create()` and `update()` but missed the equivalent for narrators, despite the composite PK on `book_narrators` making duplicates a hard error. Always check that dedup logic is applied symmetrically to all entities with the same constraint (e.g., if authors get dedup, so do narrators).
