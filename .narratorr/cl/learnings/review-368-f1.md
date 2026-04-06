---
scope: [backend]
files: [src/server/services/merge.service.ts]
issue: 368
source: review
date: 2026-04-06
---
Reviewer caught that `processNext()` released the semaphore before starting the promoted job, creating a window where a new `enqueueMerge()` could acquire the slot and start a second concurrent merge. The fix: `processNext()` either passes the slot directly to the next queued job (no release) or releases only when the queue is empty. The gap: we tested FIFO ordering but not the single-worker invariant after promotion. When implementing semaphore-based queues, always test that a third request arriving during the handoff window is correctly queued, not started.
