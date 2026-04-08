---
scope: [frontend]
files: [src/client/lib/format/merge.ts, src/client/pages/activity/MergeCard.tsx]
issue: 422
date: 2026-04-08
---
When extending a phase formatter to support new phases (like 'complete'/'failed' for terminal activity card states), add the new cases to the formatter immediately — not just to the component. Self-review caught that MergeCard's subtitle would show generic "Merging..." for terminal states because formatMergePhase only handled in-progress phases. The default case in a switch formatter silently masks missing cases; add explicit cases and test them.
