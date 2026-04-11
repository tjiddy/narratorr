---
scope: [backend]
files: [src/server/services/book.service.test.ts]
issue: 477
date: 2026-04-11
---
When overriding vi.mock'd module-level mocks (like `readdir`, `unlink`) in a test file whose `beforeEach` does NOT call `vi.clearAllMocks()`, persistent mock implementations from prior tests leak. Always call `vi.mocked(fn).mockReset()` before setting a new implementation — `mockResolvedValue`/`mockRejectedValue` after a stale implementation won't necessarily override the previously-queued behavior. This caused the readdir ENOENT test to pass in isolation but fail in the full suite.
