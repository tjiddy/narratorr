---
scope: [frontend]
files: [src/client/hooks/useEventSource.ts]
issue: 655
date: 2026-04-20
---
`patchActivityProgress` in `useEventSource` has two branches that look redundant but aren't: the in-place `setQueryData` patch (for hot rows already in a cached page) AND an `invalidateQueries` fallback (for rows that aren't in any cached page but SHOULD be — e.g. a new download that just entered the queue while the user was on the Activity tab). Removing the invalidation branch would leave newly-appearing rows unsynchronized until manual refresh. The pattern for extending this function is: add new SSE fields to the `setQueryData` patch only, and leave the `!found && hasPageQueries` branch alone. The integration test around `ActivityPage.test.tsx:993` specifically covers the cache-miss path.
