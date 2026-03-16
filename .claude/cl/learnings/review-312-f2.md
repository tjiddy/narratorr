---
scope: [frontend]
files: [src/client/pages/book/useBookActions.ts, src/client/pages/book/useBookActions.test.ts]
issue: 312
source: review
date: 2026-03-08
---
When extracting a hook, the new hook boundary needs its own co-located test file even if the parent component test already covers the happy paths. The parent test can't assert hook-internal behavior like cache invalidation, error path toasts, or callback invocations. This is especially true for hooks with multiple mutation + async side effects.
