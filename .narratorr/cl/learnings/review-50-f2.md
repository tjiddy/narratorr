---
scope: [frontend]
files: [src/client/components/DirectoryBrowserModal.tsx, src/client/pages/settings/LibrarySettingsSection.test.tsx]
issue: 50
source: review
date: 2026-03-21
---
When adding type="button" to buttons in a shared component to prevent form submission, the motivation for the fix must also motivate a test: the test should open the modal inside the form context, perform each close/dismiss/select action, and assert the form's submit handler (updateSettings) was never called. Without this test, the type="button" fix is unverified — a future regression that accidentally removes type="button" would not be caught. The self-review/coverage checks during handoff should flag any type="button" change as needing a form-context test.
