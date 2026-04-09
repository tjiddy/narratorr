---
scope: [backend]
files: [src/server/services/book.service.test.ts]
issue: 445
date: 2026-04-09
---
BookService tests use `mockReturnValueOnce` chains for the 3-query `getById` pattern (book + authors + narrators). When testing methods that call `getById` multiple times (e.g., once for validation, once for return value), each call consumes 3 mock return values. Must set up 6 mock returns. Also, `vi.fn()` mocks persist across tests unless explicitly cleared — use `(mockFn as Mock).mockClear()` before asserting `not.toHaveBeenCalled()` if prior tests in the same describe called the same mock.
