---
scope: [frontend]
files: [src/client/components/library/BulkOperationsSection.tsx, src/client/components/library/BulkOperationsSection.test.tsx]
issue: 135
source: review
date: 2026-03-26
---

The failure summary banner was gated on `isRunning`, so it disappeared the moment the job completed. The spec says "report at end" — failures should persist as a banner after completion, not only show during the run.

Root cause: Used `{isRunning && progress.failures > 0 && (...)}` instead of `{progress.failures > 0 && (...)}`. The hook correctly retains `failures` after completion (only resets on new job start or 404), but the component didn't render it post-completion.

What would have caught it: The test `'when job completes with failures, failure count is displayed'` had a trivially weak assertion (`toBeInTheDocument()` on the button). It should have asserted `screen.getByText(/3 failure/)` which would have failed immediately.

Prevention: When a spec says "report at end", the completion-state test must assert the specific output visible after completion. Every `isRunning &&` render guard should have a corresponding test for the `!isRunning` post-completion case.
