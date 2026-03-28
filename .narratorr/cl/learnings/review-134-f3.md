---
scope: [frontend]
files: [src/client/pages/manual-import/useManualImport.ts, src/client/pages/manual-import/useManualImport.test.ts]
issue: 134
source: review
date: 2026-03-26
---
When a new option is added to a hook that changes its behavior, that option must be tested at the hook level — not just through a page-level integration test. The initial PR added `libraryPath` to `useManualImport` and tested it only via `ManualImportPage.test.tsx` (Enter-key test). That page test verified one UI path but not the hook contract the spec explicitly required for "programmatic callers." The rule: any new `useManualImport` option that changes `handleScan()` behavior must have a `useManualImport.test.ts` test that calls the hook directly with that option and asserts `api.scanDirectory` was/wasn't called with specific arguments.
