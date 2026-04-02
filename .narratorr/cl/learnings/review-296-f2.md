---
scope: [frontend]
files: [src/client/pages/search/SearchTabContent.test.tsx]
issue: 296
source: review
date: 2026-04-02
---
When the spec says "modal stays open on error, user can retry or press Escape to dismiss," the test must exercise both halves: (1) modal stays open after error, AND (2) Escape still works after the error clears the pending state. A test that only asserts the modal stays open doesn't prove it's still dismissible. Error recovery tests should always include the recovery action (Escape/close), not just the error state.
