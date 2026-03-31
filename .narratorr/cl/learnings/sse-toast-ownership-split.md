---
scope: [frontend, backend]
files: [src/client/pages/book/useBookActions.ts, src/client/hooks/useEventSource.ts]
issue: 257
date: 2026-03-31
---
When moving toasts from mutation `onSuccess`/`onError` to the SSE path, API-level failures (e.g., 409 ALREADY_IN_PROGRESS) still need mutation-level `onError` handling because they fire before any SSE events. The split: SSE handles post-started success/failure toasts (visible to all users), mutation handles pre-started API rejections (visible only to initiator). Self-review caught this — easy to miss when "move toasts to SSE" is the AC.
