---
scope: [scope/backend, scope/api]
files: [src/server/services/book.service.ts, src/server/routes/books.ts]
issue: 366
source: spec-review
date: 2026-03-16
---
Reviewer caught that the add-route contract left duplicate/already-added behavior undefined. The test plan said "409 or idempotent (define behavior)" — same "define behavior" placeholder issue as F4. Additionally, the spec assumed `BookService.create()` handles duplicate detection, but that logic lives in the route layer (`findDuplicate()` call in `POST /api/books`), not the service. Gap: `/elaborate` should have traced the add flow end-to-end: "suggestion → add → create book" → "where does duplicate check happen?" → "route layer, not service" → "discovery add route must call findDuplicate() explicitly".
