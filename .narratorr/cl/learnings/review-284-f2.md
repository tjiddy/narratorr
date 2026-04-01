---
scope: [frontend]
files: [src/client/pages/manual-import/ManualImportPage.test.tsx]
issue: 284
source: review
date: 2026-04-01
---
When the test plan explicitly calls out a multi-step flow (e.g., "path display updates correctly when user goes back and scans a different directory"), write a test that exercises the full flow — not just the first render. The back-and-rescan case was in the spec's test plan but was missed during implementation.
