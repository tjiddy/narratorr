---
scope: [frontend]
files: [src/client/hooks/useEventSource.ts]
issue: 309
date: 2026-04-03
---
TanStack Query's `setQueryData` updater silently no-ops when the target entity isn't in any cached page — there's no built-in "did this update hit anything?" signal. When using patch-style SSE handlers, always track whether the patch found its target and fall back to full invalidation on cache miss. This is especially important for paginated queries where a new entity may not yet exist in any cached page.
