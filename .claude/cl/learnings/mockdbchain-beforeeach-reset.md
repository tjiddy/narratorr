---
scope: [backend, services]
files: [src/server/services/download.service.test.ts]
issue: 63
date: 2026-03-24
---
In Vitest, mock adapter objects (e.g. `{ addDownload: vi.fn() }`) must be recreated in `beforeEach`, not declared as `const` at describe scope. If declared once, `vi.clearAllMocks()` resets call counts but the same object reference is reused — mock return values from `mockReturnValue/mockResolvedValue` persist across tests because the underlying mock function is shared. Pattern: `let mockAdapter; beforeEach(() => { mockAdapter = { addDownload: vi.fn().mockResolvedValue('ext') }; ... })`.
