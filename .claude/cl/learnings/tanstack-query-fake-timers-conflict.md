---
scope: [frontend]
files: [src/client/pages/library-import/useLibraryImport.test.ts]
issue: 133
date: 2026-03-26
---
TanStack Query's internal retry and polling timers are blocked by `vi.useFakeTimers()`, causing all `useQuery`/`useMutation` calls to hang indefinitely. Do not use fake timers globally in test files that render components or hooks using TanStack Query — only use fake timers in isolated tests that explicitly need them, and call `vi.useRealTimers()` afterward.
