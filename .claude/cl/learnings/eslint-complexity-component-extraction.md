---
scope: [frontend, ui]
files: [src/client/pages/activity/QualityComparisonPanel.tsx]
issue: 40
date: 2026-03-20
---
ESLint's complexity rule counts every conditional branch, including null-guard ternaries and `??` operators. A UI component that conditionally renders several optional rows (each with `data.field !== null` guards) can easily exceed the default max of 15. Extracting a pure `buildRows(data)` function (which absorbs the null-guard branches) and a sub-component (`ProbeFailureMessage`) are the right fixes — they also improve testability. Expect this pattern whenever a display component has 4+ conditional render paths.
