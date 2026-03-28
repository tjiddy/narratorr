---
scope: [scope/frontend]
files: [src/client/pages/manual-import/useManualImport.ts, src/client/pages/manual-import/useManualImport.test.ts]
issue: 81
source: review
date: 2026-03-25
---
`useManualImport` gained a new `onScanSuccess` optional callback but no hook-level tests were added to cover it. The page-level tests indirectly exercised the happy path, but no test verified the callback wasn't called on zero-discoveries or rejection branches.

Why missed: The callback was wired at the page level (`ManualImportPage`) which already had coverage, giving false confidence. But the hook itself had no coverage for the three branches: success-with-discoveries, success-without-discoveries, and rejection.

What would have prevented it: "Test every layer you changed" — when `useManualImport` gained new API surface, the hook test file should have been updated as part of the same module's red/green cycle, not just the page tests.
