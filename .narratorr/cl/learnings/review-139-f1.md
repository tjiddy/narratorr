---
scope: [frontend]
files: [src/client/components/manual-import/ImportCard.tsx]
issue: 139
source: review
date: 2026-03-26
---
When extracting a condition from a multi-branch ternary, verify the fallback branch doesn't apply to the new case. The dim-class ternary had `(isDuplicate && !row.selected) ? 'opacity-60' : (!confidence ? 'opacity-50' : '')` — the fallback was meant for non-duplicate pending rows, but selected duplicates (no matchResult → confidence=undefined) also hit it and got `opacity-50`. The fix is to branch on `isDuplicate` first, then handle selected/unselected separately, so the `opacity-50` branch is only reachable for non-duplicate rows.
