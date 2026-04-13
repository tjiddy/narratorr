---
scope: [backend]
files: [src/server/routes/activity.test.ts]
issue: 525
date: 2026-04-13
---
Activity route tests override `services.import.tryAcquireSlot/releaseSlot` with real `Semaphore` methods (not mocks), so `expect(services.import.releaseSlot).toHaveBeenCalled()` throws "not a spy." Assert on proxy-auto-mocked methods (like `drainQueuedImports`) instead. The existing `releases semaphore slot when import fails` test verifies slot release by checking semaphore capacity directly.
