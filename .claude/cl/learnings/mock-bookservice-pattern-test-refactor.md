---
scope: [backend, services]
files: [src/server/services/tagging.service.test.ts, src/server/services/import.service.test.ts]
issue: 79
date: 2026-03-24
---
When refactoring a service to use BookService delegation, existing tests have many `db.select.mockReturnValueOnce()` chains that need bulk removal. Use `sed` for the bulk removal of the common pattern, then targeted edits for custom variants. Add `mockBookService = { getById: vi.fn() }` in `beforeEach` and a `makeBook(overrides)` helper to avoid per-test boilerplate. The pattern: add `mockBookService as never` as the last constructor arg everywhere in the test file.
