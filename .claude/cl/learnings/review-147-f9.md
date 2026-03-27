---
scope: [scope/frontend]
files: [src/client/pages/settings/ProcessingSettingsSection.tsx, src/client/pages/settings/ProcessingSettingsSection.test.tsx]
issue: 147
source: review
date: 2026-03-27
---
The reviewer caught that ProcessingSettingsSection's ffmpeg probe non-Error fallback ('ffmpeg probe failed') had no test. The component sets both probeError state (rendered as visible text) and calls toast.error(), and the existing test only covered the Error path.

Why we missed it: Same systemic gap as F1-F9. The round-1 fix addressed 5 sites but left 4 others unresolved because the sibling-pattern check in step 3 wasn't applied exhaustively across the entire diff.

What would have prevented it: A grep-based exhaustive scan of all ternary `instanceof Error ? error.message : 'fallback'` patterns in the diff, executed once before any push, would catch all instances in one pass rather than having the reviewer enumerate them across multiple rounds.
