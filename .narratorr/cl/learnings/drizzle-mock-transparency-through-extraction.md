---
scope: [backend]
files: [src/server/utils/find-or-create-person.ts, src/server/services/book.service.ts, src/server/services/import-list.service.ts, src/server/jobs/enrichment.ts]
issue: 482
date: 2026-04-12
---
When extracting Drizzle ORM query logic from service methods into shared utilities, the `mockDbChain()` proxy pattern means existing tests pass without modification — the mock stubs are set on the `db`/`tx` object, and the same object gets passed to the extracted function. This makes DRY extractions of DB query patterns nearly zero-friction for test suites, even when 3+ test files assert the extracted behavior.
