---
scope: [frontend]
files: [src/client/hooks/useMergeProgress.ts, src/client/hooks/useEventSource.test.ts]
issue: 430
date: 2026-04-09
---
Changing `useMergeProgress` per-book selector from returning `null` to returning terminal state caused a cascade failure in `useEventSource.test.ts` — tests prior to the "store transitions" describe block left terminal entries for book 42 in the shared module-level store, and the existing `afterEach` cleanup wasn't sufficient because it only ran *after* each test (not before the first). Adding `beforeEach(resetMergeStore)` fixed it. Lesson: module-level stores shared across test files need `beforeEach` reset, not just `afterEach` cleanup, because test ordering can leak state.
