---
scope: [frontend, backend]
files: [src/client/pages/book/BookDetails.tsx, src/server/routes/retry-import.ts]
issue: 635
source: review
date: 2026-04-17
---
When an AC says a UI affordance "keys off condition A AND condition B," both conditions must be checked client-side — not just the simpler one with a server fallback for the other. Showing a button that always returns 400 for a subset of users is bad UX even if the error is handled. Added a GET endpoint to check retry availability and a query in the detail page.
