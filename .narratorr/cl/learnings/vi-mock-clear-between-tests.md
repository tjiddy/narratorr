---
scope: [backend]
files: [src/server/services/import-adapters/manual.test.ts]
issue: 650
date: 2026-04-18
---
When adding a new `vi.mock()` for a module (e.g., `paths.js`) to an existing test file, the mock's call history persists across tests. Tests that assert `not.toHaveBeenCalled()` will fail if they run after a test that DID call the mock. Solution: add `vi.mocked(fn).mockClear()` + re-setup the return value in `beforeEach`. Using `vi.clearAllMocks()` would reset ALL mocks including the top-level `vi.mock()` default implementations, so prefer targeted `.mockClear()` on the specific mock.
