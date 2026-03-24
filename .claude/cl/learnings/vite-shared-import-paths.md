---
scope: [frontend]
files: [src/client/hooks/useEventSource.ts]
issue: 283
date: 2026-03-10
---
Client code importing from `src/shared/` must use correct relative paths. From `src/client/hooks/`, the path to `src/shared/schemas/` is `../../shared/schemas/` (two levels up), not `../../../shared/schemas/` (three levels). The `@/` path alias only resolves to `src/client/`, not `src/`. Vite's import analysis plugin gives a clear error when the path doesn't resolve, but it's easy to miscalculate depth.
