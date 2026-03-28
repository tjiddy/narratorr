---
scope: [frontend]
files: [src/client/pages/activity/ActivityPage.tsx, src/client/pages/activity/ActivityPage.test.tsx]
issue: 54
source: review
date: 2026-03-21
---
When a mutation uses `onSettled` to close a modal (so it closes on both success and failure), the close behavior needs explicit assertions in both branches. Testing only the toast side-effect doesn't prove the dialog disappears. Pattern: for any `onSettled: () => setOpen(false)` pattern, add `waitFor(() => expect(queryByRole('dialog')).not.toBeInTheDocument())` in both success and error tests.
