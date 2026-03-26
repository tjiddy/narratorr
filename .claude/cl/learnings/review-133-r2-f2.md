---
scope: [frontend]
files: [src/client/pages/library-import/useLibraryImport.ts, src/client/pages/library-import/LibraryImportPage.tsx]
issue: 133
source: review
date: 2026-03-26
---
Every new recovery/retry action needs its own test covering the full round-trip: trigger failure → assert error state → click retry → assert error clears and the underlying action fires with correct arguments. Adding a "Retry matching" CTA without testing the click→startMatchJob→error-clear flow leaves the recovery path unproven. Recovery paths are failure-mode code and often have subtle wiring bugs (stale refs, missing resets) that only surface under test.
