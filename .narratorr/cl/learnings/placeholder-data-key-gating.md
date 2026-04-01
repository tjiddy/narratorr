---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.tsx, src/client/hooks/useLibrary.ts]
issue: 267
date: 2026-04-01
---
When `useQuery` uses `placeholderData: (prev) => prev`, changing the queryKey keeps old data visible (`isPlaceholderData = true`) until the new response settles. A React `key` derived from the same params that change the queryKey will flip immediately during the placeholder phase — NOT after the settled response arrives. To gate remount on settled data, track the key in state and only update it when `isPlaceholderData` is false.
