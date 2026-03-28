---
scope: [frontend]
files: [src/client/index.css, src/client/pages/library/StatusDropdown.tsx, src/client/pages/library/SortDropdown.tsx, src/client/pages/library/OverflowMenu.tsx]
issue: 148
date: 2026-03-26
---
The codebase has a shared `focus-ring` utility defined in `src/client/index.css:258` that expands to `focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background`. Using bare `focus:outline-none` without the `focus-visible:ring` replacement is an a11y anti-pattern that removes all keyboard focus indication. Always use the `focus-ring` utility class instead. As of #148, `StatusDropdown` and `SortDropdown` are fixed; `OverflowMenu` and `BookContextMenu` still use the anti-pattern and need a follow-up.
