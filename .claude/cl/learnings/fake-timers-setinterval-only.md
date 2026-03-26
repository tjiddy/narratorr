---
scope: [frontend]
files: [src/client/pages/library-import/LibraryImportPage.test.tsx, src/client/hooks/useMatchJob.test.ts]
issue: 142
date: 2026-03-26
---
When a page uses both TanStack Query (which uses setTimeout internally) and a setInterval-based polling hook (useMatchJob), use `vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })` instead of full `vi.useFakeTimers()`. This fakes only the interval timer so `vi.advanceTimersByTime(2000)` drives the poll, while leaving setTimeout real so TanStack Query's retry/staleTime logic and Testing Library's waitFor polling continue to work. Scoped to a nested describe with beforeEach/afterEach to avoid affecting unrelated tests in the same file.
