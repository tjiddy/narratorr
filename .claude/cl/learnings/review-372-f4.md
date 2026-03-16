---
scope: [scope/frontend]
files: [src/client/hooks/usePagination.ts]
issue: 372
source: review
date: 2026-03-16
---
Pagination hooks must handle the case where the total shrinks below the current page (e.g., delete last item on page 5 of 5). Without a clampToTotal() mechanism, the user gets stuck on an empty page with no controls to navigate back. This should be a default feature of any shared pagination hook — not left to each consumer.
