---
scope: [scope/frontend]
files: [src/client/pages/manual-import/ManualImportPage.tsx, src/client/pages/manual-import/ManualImportPage.test.tsx]
issue: 81
source: review
date: 2026-03-25
---
New `useEffect` seeding logic in `ManualImportPage` had no page-level assertions. Loading/error-state tests only verified no crash and path input visibility — they didn't assert `seedLibraryRoot` was or wasn't called.

Why missed: The loading/error-state tests were primarily copied from a "doesn't crash" template. The new seeding behavior was never made a first-class assertion target.

What would have prevented it: The test plan explicitly listed "seeding runs after data is available, not on mount" and "no seeding on loading/error". Mapping those spec lines 1:1 to test assertions before writing the effect would have forced explicit coverage.
