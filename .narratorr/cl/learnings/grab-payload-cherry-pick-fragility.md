---
scope: [backend]
files: [src/server/services/retry-search.ts, src/server/services/search-pipeline.ts, src/server/jobs/search.ts, src/server/jobs/rss.ts]
issue: 385
date: 2026-04-06
---
All four backend grab call sites manually cherry-pick fields from `SearchResult` into the grab payload. When a new optional field is added to the grab schema (like `indexerId`), it's easy to miss adding it to all sites. The loose `expect.objectContaining()` assertions in tests didn't catch this because they only checked 1-2 fields. Tightening test assertions to include all forwarded fields is the cheapest regression guard for this pattern.
