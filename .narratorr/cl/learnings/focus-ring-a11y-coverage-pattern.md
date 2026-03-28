---
scope: [frontend]
files: [src/client/pages/library/OverflowMenu.tsx, src/client/pages/library/BookContextMenu.tsx]
issue: 178
date: 2026-03-28
---
CSS-only a11y fixes (replacing focus:outline-none with focus-ring) require a dedicated accessibility test block asserting toHaveClass('focus-ring') on every menu item — behavioral tests (keyboard nav, click handlers) do not catch class regressions. Mirror the pattern in StatusDropdown.test.tsx:439-452: open menu, getAllByRole('menuitem'), forEach toHaveClass('focus-ring'). Without this, the fix can silently revert in a future refactor.
