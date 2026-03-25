---
scope: [frontend]
files: [src/client/pages/manual-import/PathStep.tsx, src/client/pages/manual-import/ManualImportPage.test.tsx]
issue: 100
date: 2026-03-25
---
The handoff coverage review catches untested behaviors in changed files even when those behaviors pre-date the current issue. A JSX reorder that touches a file with existing coverage gaps will surface those gaps at review time. Plan for 1-2 extra test commits on any "layout-only" chore that modifies a file with rich logic (error clearing, disabled-state conditions).
