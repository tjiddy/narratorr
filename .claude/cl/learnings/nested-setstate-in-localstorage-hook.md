---
scope: [frontend]
files: [src/client/pages/manual-import/useFolderHistory.ts]
issue: 81
date: 2026-03-25
---
When a localStorage hook needs to update two related state slices atomically (e.g., promoteToFavorite must remove from recents AND add to favorites), calling `setFavorites` inside the `setRecents` updater function works correctly in React's concurrent mode because both updates are batched. The nested setter captures the latest prev value for the second slice. This avoids a race window that would exist with two sequential `setState` calls reading potentially stale state.
