---
scope: [infra]
files: [e2e/tests/critical-path/search-grab-import.spec.ts]
issue: 614
source: review
date: 2026-04-17
---
Modal close after successful grab was an explicit interaction in the spec but not asserted in the test. A regression where the dialog stayed open would pass. Lesson: every spec interaction with a distinct outcome (toast AND modal close AND pending state) gets its own assertion — enumeration in the spec is not aggregation in the test. The test plan completeness list in CLAUDE.md/testing.md should explicitly name "modal lifecycle (open/close)" as a common missed assertion.
