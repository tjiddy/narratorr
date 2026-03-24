---
scope: [backend, services]
files: [src/server/services/book-list.service.ts, src/server/services/tagging.service.test.ts]
issue: 422
date: 2026-03-17
---
Calling `getTableColumns()` at module scope in a service file breaks any test that partially mocks `drizzle-orm` via a different import chain (e.g., tagging.service.test.ts mocking only `eq`). The fix is to wrap the call in a function so it evaluates lazily at call time rather than import time. Any test mocking drizzle-orm should use `importOriginal` to avoid this class of breakage.
