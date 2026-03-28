---
scope: [scope/frontend]
files: [src/client/pages/manual-import/PathStep.tsx, src/client/pages/manual-import/ManualImportPage.test.tsx]
issue: 81
source: review
date: 2026-03-25
---
`PathStep` renders folder timestamps via `formatDate()` but no test verified the formatted output for a known date. The date formatter pattern was spec-required, but it was left untested.

Why missed: The timestamp span uses `hidden group-hover:block` CSS, making it easy to overlook as a render target. The formatter was written but treated as "implementation detail" rather than a user-visible AC requirement.

What would have prevented it: The spec explicitly called out the date format ("Mar 5, 2026"). Any spec-required output format is a testable contract — it must have a test that passes a known input and asserts the exact output string.
