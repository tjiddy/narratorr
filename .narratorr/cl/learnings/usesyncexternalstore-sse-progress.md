---
scope: [frontend]
files: [src/client/hooks/useMergeProgress.ts, src/client/hooks/useEventSource.ts]
issue: 257
date: 2026-03-31
---
The `useSyncExternalStore` pattern for module-level reactive state (already used for SSE connection state) works cleanly for per-entity progress tracking. A `Map<number, Progress | null>` keyed by entity ID with a shared listener set lets any component subscribe to progress for a specific entity without prop drilling or context providers. The SSE handler writes to the store; components read via the hook.
