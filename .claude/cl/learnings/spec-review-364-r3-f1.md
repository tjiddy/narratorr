---
scope: [scope/frontend]
files: [src/client/lib/api/search.ts, src/client/lib/api/books.ts]
issue: 364
source: spec-review
date: 2026-03-14
---
Round 2 defined an index-based tie-breaker for duplicate keys, but index is order-dependent — the exact problem the issue was trying to fix. The types actually had order-independent differentiator fields (`downloadUrl`, `detailsUrl` on SearchResult; `imageUrl` on AuthorMetadata; `providerId` on BookMetadata) that should have been preferred. Root cause: treated index as a universally acceptable fallback without checking whether the types had better options. When defining key contracts, exhaust all available stable fields on the type before falling back to array index.
