---
scope: [core]
files: [src/core/utils/fetch-with-timeout.ts]
issue: 23
date: 2026-03-20
---
When `fetch()` is called with `redirect: 'manual'`, it returns 3xx responses as opaque redirect responses rather than following them. The key contract for propagating auth-proxy errors to users without touching any caller: `fetchWithTimeout` must **throw** (not return) for 3xx statuses. All download-client and notifier callers already wrap operations in `try/catch` and surface `error.message` via `{ success: false, message }` — so throwing from the shared utility means zero caller changes needed. If it returned the 3xx Response instead, every caller's `!response.ok` check would swallow it with a generic "HTTP 302" message, defeating the purpose.
