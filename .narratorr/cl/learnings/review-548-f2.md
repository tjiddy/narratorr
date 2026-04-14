---
scope: [frontend]
files: [src/client/components/FilterPill.tsx, src/client/pages/library/StatusDropdown.tsx, src/client/pages/library/SortDropdown.tsx, src/client/pages/library/LibraryToolbar.tsx]
issue: 548
source: review
date: 2026-04-14
---
Stopped FilterPill rollout at 1/4 callers because I judged the other 3 as "structurally different." The AC explicitly named all 4 files. When an AC enumerates specific files, all must be addressed — either implement or dispute in the PR, not silently skip. The fix was adding a `toolbar` variant and `forwardRef` to FilterPill, which took ~15 minutes and satisfied the AC cleanly.
