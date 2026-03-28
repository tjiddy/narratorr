---
scope: [scope/frontend, scope/ui]
files: [src/client/pages/library/StatusDropdown.tsx, src/client/pages/library/SortDropdown.tsx, src/client/pages/library/OverflowMenu.tsx]
issue: 124
source: review
date: 2026-03-26
---
The reviewer caught that all three trigger buttons called `setOpen((o) => !o)` directly instead of routing the close path through `handleClose()`. The `focusIndex` reset only lived in `handleClose()`, so closing via trigger preserved stale keyboard state. On reopen, `useEffect([focusIndex, open])` would focus the last-used item instead of the first option.

Why we missed it: When writing `handleClose()` we focused on the "close from keyboard/selection" paths. The trigger toggle was written first as the simple `setOpen((o) => !o)` pattern and was never updated when `handleClose()` was added. The fix (route through `handleClose()`) is symmetric with how the other close paths work.

What would have prevented it: When adding per-component close handlers that reset local state, audit every other call site that calls `setOpen(false)` directly and ask whether it should go through the same reset path. The trigger toggle is the most common missed case.
