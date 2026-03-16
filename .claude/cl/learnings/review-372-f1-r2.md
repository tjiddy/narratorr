---
scope: [scope/frontend, scope/backend]
files: [src/client/hooks/useLibrary.ts, src/server/routes/books.ts, src/server/services/book.service.ts]
issue: 372
source: review
date: 2026-03-16
---
When non-paginated callers need the full dataset, raising the limit is a band-aid — the limit exists for a reason and any hardcoded cap will eventually be exceeded. The correct fix is a dedicated lightweight endpoint that returns only the fields needed (e.g., identifiers for duplicate detection) without pagination. This pattern applies whenever callers need "existence checks" against the full dataset: use a minimal projection endpoint, not a capped version of the paginated endpoint.
