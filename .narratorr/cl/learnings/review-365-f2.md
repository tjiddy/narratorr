---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx]
issue: 365
source: review
date: 2026-04-06
---
When changing backend search behavior, the frontend test mock must be updated to match the new contract. `mockLibraryData()` still matched narrators pre-fix, making it inconsistent with the actual backend. Also, the user-visible contract change (narrator-only search returns no results) needs an explicit page-level interaction test, not just service-level coverage.
