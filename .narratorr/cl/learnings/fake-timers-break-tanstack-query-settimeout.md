---
scope: [frontend]
files: [src/client/hooks/useSearchStream.ts, src/client/hooks/useSearchStream.test.tsx]
issue: 306
date: 2026-04-02
---
`vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })` also deadlocks TanStack Query, not just full `useFakeTimers()`. The CLAUDE.md gotcha only mentions faking setInterval as safe. For hooks that use setTimeout and are wrapped in Query providers, use real short timeouts (e.g., 100ms) with `waitFor()` instead of fake timers.
