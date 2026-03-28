---
scope: [frontend]
files: [src/client/pages/book/BookDetails.test.tsx]
issue: 111
date: 2026-03-25
---
When adding a confirmation modal to an existing button, any test that clicks the button and immediately asserts the API was called will break — clicking now opens a dialog, not fires the mutation. Budget time to find and update all affected tests before running the full suite. For this issue: 5 existing retag/rename tests needed updating to click through the modal confirm step. Search the test file for `.click(screen.getByText('<ButtonLabel>'))` followed by `expect(api.<action>).toHaveBeenCalled` to find all affected tests.
