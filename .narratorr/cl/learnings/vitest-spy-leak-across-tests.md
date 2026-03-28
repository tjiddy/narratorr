---
scope: [frontend]
files: [src/client/pages/manual-import/useFolderHistory.test.ts]
issue: 81
date: 2026-03-25
---
`vi.spyOn(Storage.prototype, 'setItem').mockImplementation(...)` persists across tests unless `vi.restoreAllMocks()` is called in `afterEach`. Without this, later tests in the same file will fail because `localStorage.setItem` still throws. Always pair `vi.spyOn` with `vi.restoreAllMocks()` in `afterEach`.
