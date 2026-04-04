---
scope: [frontend]
files: [src/client/pages/library-import/useLibraryImport.test.ts]
issue: 342
source: review
date: 2026-04-04
---
When changing derived counts (readyCount, pendingCount, etc.) from `!isDuplicate` to `!isDbDuplicate`, each count needs its own direct assertion with the new row type. Testing only some counts (pendingCount, duplicateCount, allSelected) while skipping others (readyCount) leaves a regression gap. The readyCount assertion is particularly important because it requires both selection AND a high-confidence match result — a compound condition that needs setup to prove.
