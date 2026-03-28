---
scope: [frontend]
files: [src/client/pages/library-import/useLibraryImport.test.ts]
issue: 185
date: 2026-03-28
---
When mocking TanStack Query `useQuery` data as `undefined` (to simulate query-not-yet-resolved), TanStack Query logs a warning "Query data cannot be undefined." This is expected behavior — the warning is harmless in tests but confirms the guard (`&& bookIdentifiers`) in production code is load-bearing. Use `mockReturnValue(undefined as never)` to bypass TypeScript while still exercising the runtime guard.
