---
scope: [scope/frontend]
files: [src/client/pages/library/FilterRow.tsx, src/client/pages/library/FilterRow.test.tsx]
issue: 363
source: spec-review
date: 2026-03-14
---
Reviewer caught that the FilterRow empty-options boundary test contradicted the component's existing hide-when-empty contract — selects are conditionally rendered only when the option list exceeds a threshold. The `/elaborate` skill wrote a boundary case ("FilterRow with no options still has accessible labels") without reading FilterRow.tsx to verify that the controls even render in that scenario.

Root cause: `/elaborate`'s subagent read the source and noted the conditional rendering, but the test plan was written generically without cross-referencing the conditional rendering guards against each proposed test case.

Prevention: When writing boundary/edge-case tests for components with conditional rendering, explicitly verify which props/states cause the target element to exist in the DOM before asserting attributes on it.
