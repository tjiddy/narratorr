---
scope: [frontend]
files: [src/client/components/Tabs.tsx, src/client/pages/activity/ActivityPage.test.tsx]
issue: 548
date: 2026-04-14
---
Extracting a shared Tabs component with `role="tab"` changes how Testing Library queries find the buttons. Existing tests using `getByRole('button', { name: /history/i })` must be updated to `getByRole('tab', { name: /history/i })`. This is predictable but easy to miss — always grep test files for `getByRole('button'` queries that target tab buttons before committing.
