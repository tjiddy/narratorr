---
scope: [backend]
files: [src/server/services/merge.service.ts]
issue: 368
source: review
date: 2026-04-06
---
Reviewer caught that duplicate detection in `validatePreEnqueue()` happened after multiple `await` calls, so two concurrent same-book requests could both pass the `inProgress.has()` check before either added to the set. The fix: check and mark `inProgress` synchronously at the top of `enqueueMerge()` (before any await), then clean up on validation failure. In JavaScript's cooperative multitasking, placing guards after async boundaries creates TOCTOU races — always do check-and-mark atomically (no await gap) for concurrency guards.
