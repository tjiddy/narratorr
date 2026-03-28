---
scope: [backend]
files: [apps/narratorr/src/server/__tests__/helpers.ts]
issue: 163
date: 2026-02-22
---
Proxy-based mock services that auto-create `vi.fn()` stubs MUST default to `mockResolvedValue(undefined)` for async service methods. Bare `vi.fn()` returns `undefined`, which breaks fire-and-forget patterns like `.catch()` chains. This is non-obvious because the error (`undefined.catch is not a function`) appears in the route handler, not the test.
