---
scope: [frontend]
files: [src/client/components/ManualAddForm.tsx]
issue: 287
date: 2026-04-01
---
In JavaScript, the string `"0"` is truthy (unlike the number `0`). Code like `data.seriesPosition ? Number(data.seriesPosition) : undefined` works correctly for `"0"` input. The debt log incorrectly flagged this as a bug — always verify JS truthiness rules before assuming a falsy-check defect. Worth having a regression test to document this non-obvious behavior.
