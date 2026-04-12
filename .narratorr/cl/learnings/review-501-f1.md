---
scope: [frontend]
files: [src/client/pages/discover/DiscoverPage.tsx]
issue: 501
source: review
date: 2026-04-12
---
When a mutation marks a server-side record as a different status (e.g., suggestion → 'added'), invalidating the query that only fetches the original status ('pending') will remove the record from the UI. The local state tracking (addedIds) is overwritten by the refetch. Fix: don't invalidate the parent query on add — only invalidate downstream queries (books, bookStats). This pattern applies anywhere optimistic local state conflicts with a status-filtering query.
