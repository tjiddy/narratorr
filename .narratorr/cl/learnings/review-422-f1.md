---
scope: [frontend]
files: [src/client/hooks/useMergeProgress.ts]
issue: 422
source: review
date: 2026-04-08
---
When a module-level store has dismiss timers (setTimeout), setting new non-terminal state for the same key must clear any pending dismiss timer from a prior terminal state. The original code only cleared timers on explicit null and on scheduleDismiss(), but the non-terminal path silently overwrote the map entry without canceling the old timer. The stale timer then fired and deleted the new active entry. Pattern: any state transition that replaces a timed entry must clear the old timer first, not just the terminal→dismiss path. This was missed because the test plan focused on the dismiss-after-delay scenario but not the re-entry-within-delay scenario.
