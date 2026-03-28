---
scope: [backend]
files: [apps/narratorr/src/server/__tests__/helpers.ts]
issue: 163
date: 2026-02-22
---
`mockReset()` clears everything — return values, implementations, and call history. If your mock factory sets default return values (like `mockResolvedValue(undefined)`), `resetMockServices()` must re-apply those defaults after reset. Otherwise the stubs revert to bare `vi.fn()` behavior.
