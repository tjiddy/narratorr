---
scope: [frontend]
files: [src/client/pages/library-import/LibraryImportPage.test.tsx]
issue: 201
source: review
date: 2026-03-29
---
When testing a disabled-button branch that depends on a computed count (selectedUnmatchedCount > 0), the test must actually put the system into the specific state that triggers that branch — not just verify the button is disabled for any reason. In this case, mergeMatchResults auto-deselects confidence=none rows, so selectedUnmatchedCount was 0 after the poll. The test needed to re-select the unmatched row to exercise the actual branch. Root cause: spec said "disabled when selectedUnmatchedCount > 0" but the test setup made that state unreachable without an additional user action.
