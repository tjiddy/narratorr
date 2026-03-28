---
scope: [frontend]
files: [src/client/pages/settings/IndexersSettings.test.tsx]
issue: 26
source: review
date: 2026-03-20
---
When removing a UI element (button/modal), deleting the old positive interaction test is not enough — it leaves a regression gap. The test suite needs a replacement absence assertion to catch if the element is accidentally reintroduced. Pattern: after deleting a feature's positive test, add `screen.queryByRole(...)` / `screen.queryByText(...)` assertions returning null for the removed entry point. This applies to any UI deletion: removed nav items, removed buttons, removed modal triggers.
