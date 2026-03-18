---
scope: [scope/core]
files: [src/core/utils/fetch-with-timeout.ts]
issue: 431
date: 2026-03-17
---
AbortSignal.timeout() is a clean replacement for the manual AbortController+setTimeout+clearTimeout pattern. No try/finally needed for cleanup. However, test mocking changes — vi.useFakeTimers() can't control AbortSignal.timeout(), so tests that verify timeout behavior need to mock AbortSignal.timeout to return an already-aborted signal instead.
