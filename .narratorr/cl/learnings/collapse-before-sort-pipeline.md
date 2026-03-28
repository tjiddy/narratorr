---
scope: [frontend]
files: [apps/narratorr/src/client/pages/library/helpers.ts, apps/narratorr/src/client/pages/library/useLibraryFilters.ts]
issue: 249
date: 2026-02-25
---
When implementing grouping/collapsing with sorting, the pipeline order matters: collapse must happen BEFORE sort, not after. If you sort first then collapse, the collapsed representative might not end up in the correct position in the final sorted output. Pipeline: filter → collapse → sort ensures the final sort guarantees apply to the collapsed output.
