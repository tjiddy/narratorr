---
scope: [frontend]
files: [src/client/pages/library/useLibraryPageState.ts]
issue: 635
source: review
date: 2026-04-17
---
Bypassing useMutation (calling api.* directly) in page-level state hooks creates a silent failure path. Every direct API call in a non-mutation context must have explicit error handling with user-visible feedback (toast). The detail-page path already had correct error handling via useMutation onError — the library-grid path should have matched that contract.
