---
scope: [backend]
files: [src/server/jobs/rss.ts]
issue: 532
date: 2026-04-13
---
RSS enrichment runs per-book (after matching), not globally like search-pipeline's `postProcessSearchResults()`. When moving a filter after enrichment in RSS, it must go inside the per-book loop — not at the global level — to avoid broadening the NZB fetch surface to unmatched items. The spec review caught this: two implementations can satisfy the same AC while producing different fetch behavior.
