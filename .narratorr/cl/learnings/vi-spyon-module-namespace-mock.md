---
scope: [backend]
files: [src/server/routes/search-stream.test.ts]
issue: 563
date: 2026-04-15
---
To replace a module-level `vi.mock` with per-test control, import the module as a namespace (`import * as mod from '...'`) and use `vi.spyOn(mod, 'fn')` in `beforeEach` with `.mockRestore()` in `afterEach`. This allows mocked and unmocked tests to coexist in the same file — the spy only affects the current test scope.
