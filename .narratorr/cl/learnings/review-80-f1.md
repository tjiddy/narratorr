---
scope: [scope/frontend, scope/ui]
files: [src/client/pages/manual-import/ManualImportPage.test.tsx]
issue: 80
source: review
date: 2026-03-24
---
The reviewer caught that unit-level tests for ImportCard and useManualImport were insufficient — no test exercised the full page-level flow: match arrives → narrator appears in card → user picks alternate match → card updates.

Why we missed it: The TDD cycle produced tests at the component boundary (ImportCard.test.tsx) and hook boundary (useManualImport.test.ts), but didn't include a page-level integration test that chains the complete interaction. AC3 ("narrator updates without page reload") is inherently a cross-component behavior and requires an integration test to verify the wiring between useManualImport → ImportCard.

What would have prevented it: For behaviors that span hook → component → rendered UI, include at least one page-level test using scanAndReview + simulateMatchResults that exercises the full flow end-to-end. The test plan completeness standard's "End-to-end flows" category applies here — applying it strictly to the narrator update flow would have caught the gap.

Additional gotcha: getByText('Stephen Fry') fails when the narrator is rendered inline with file size ("Stephen Fry · 476 MB" in a single span). Use regex matchers (/Stephen Fry/) for narrator text in ImportCard assertions.
