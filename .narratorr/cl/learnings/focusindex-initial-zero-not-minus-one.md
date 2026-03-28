---
scope: [frontend]
files: [src/client/pages/library/StatusDropdown.tsx, src/client/pages/library/SortDropdown.tsx, src/client/pages/library/OverflowMenu.tsx]
issue: 124
date: 2026-03-26
---
Initializing `focusIndex` to `0` (not `-1`) combined with the `if (!open) return` guard in the focus-sync effect means the first option is pre-targeted as soon as `open` becomes true, without a separate "reset on open" effect. The `-1` sentinel approach requires a second effect to detect the open→closed transition, which triggers the setState-in-effect lint error.
