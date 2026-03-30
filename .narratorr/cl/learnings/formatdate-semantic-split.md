---
scope: [frontend]
files: [src/client/lib/format.ts, src/client/components/EventHistoryCard.tsx]
issue: 224
date: 2026-03-30
---
When consolidating "duplicate" formatDate functions, check if they're semantically identical. LibraryTableView and PathStep had identical absolute date formatters, but EventHistoryCard had a relative time formatter ("5m ago", "2d ago"). The spec initially grouped all three as the same DRY-2 violation. Elaboration caught the semantic difference and split the AC into two exports: `formatDate` and `formatRelativeDate`. Always read the actual function body before assuming duplication.
