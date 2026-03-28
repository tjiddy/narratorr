---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.tsx]
issue: 146
date: 2026-03-26
---
When extracting an inline closure that toggles state based on current value (e.g., `setId(prev === x ? null : x)`), use the functional updater form so the current state value isn't captured in the closure deps. This keeps the `useCallback` deps array empty (or minimal), so the callback identity stays stable across renders. If you write `setId(openMenuId === x ? null : x)` instead, you must add `openMenuId` to deps, which recreates the callback on every toggle and defeats the purpose of `useCallback`.
