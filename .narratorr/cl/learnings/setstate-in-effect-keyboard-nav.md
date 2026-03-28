---
scope: [frontend]
files: [src/client/pages/library/StatusDropdown.tsx, src/client/pages/library/SortDropdown.tsx, src/client/pages/library/OverflowMenu.tsx]
issue: 124
date: 2026-03-26
---
The `react-hooks/set-state-in-effect` ESLint rule blocks the natural pattern for resetting `focusIndex` when a dropdown closes. Instead of `useEffect(() => { if (open) setFocusIndex(0); }, [open])`, combine the open-guard and focus-sync into one effect: `useEffect(() => { if (!open) return; items[focusIndex]?.focus(); }, [focusIndex, open])`, and reset focusIndex to 0 in all close/select event handlers (not effects). This eliminates the cascading render triggered by the two-effect approach.
