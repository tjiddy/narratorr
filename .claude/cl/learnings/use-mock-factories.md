---
scope: [backend]
files: [src/server/__tests__/factories.ts, src/server/services/retry-search.test.ts]
issue: 270
date: 2026-03-08
---
Always use `createMockDbBook()` / `createMockDbAuthor()` from `__tests__/factories.ts` instead of hand-rolling mock objects for DB row types. The schema has many nullable fields (narrator, genres, audioCodec, etc.) that are easy to miss, causing typecheck failures. The factories handle all fields with sensible defaults.
