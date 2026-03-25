---
scope: [frontend]
files: [src/client/pages/manual-import/PathStep.tsx, src/client/pages/manual-import/ManualImportPage.test.tsx]
issue: 81
date: 2026-03-25
---
The coverage review caught 4 untested button-click interactions in PathStep (promote, demote, remove-recent, remove-favorite) that were present in the component but had no tests asserting the callbacks were invoked. Click-based UI components with multiple action buttons need explicit interaction tests for each button, not just the primary "select" action. Render-only tests prove nothing about interactive behavior.
