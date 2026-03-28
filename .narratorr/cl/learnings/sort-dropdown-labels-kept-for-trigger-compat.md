---
scope: [frontend]
files: [src/client/pages/library/SortDropdown.tsx]
issue: 110
date: 2026-03-25
---
When trimming the sortFields array in SortDropdown, keep the full label maps (sortFieldLabels, sortDirectionLabels) covering all 8 SortField values. The getTriggerLabel() function receives any SortField prop including 'quality'/'size'/'format' (in case coercion hasn't fired yet or is bypassed), so the maps need full coverage to avoid undefined label renders. Only the sortFields array controls which options are rendered.
