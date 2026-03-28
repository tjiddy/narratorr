---
scope: [scope/services, scope/backend]
files: [src/server/jobs/search.test.ts, src/server/jobs/rss.test.ts]
issue: 397
date: 2026-03-16
---
When splitting a service, test mock factories that combine methods from the old service need to be split too. For rss.test.ts, creating a `createMockBookServices()` helper that returns `{ bookList, book }` was more efficient than updating 30+ individual test calls. For search.test.ts, separate `createMockBookListService` and `createMockBookService` factories worked because the describe blocks mapped cleanly to the service split.
