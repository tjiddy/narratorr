---
scope: [frontend]
files: [src/client/components/manual-import/ImportSummaryBar.tsx]
issue: 143
date: 2026-03-26
---
Changing a required prop to optional (`fn: (x: T) => void` → `fn?: (x: T) => void`) also requires updating any call site inside the component to use optional chaining (`fn?.(x)` not `fn(x)`). TypeScript error TS2722 "Cannot invoke an object which is possibly 'undefined'" catches this, but only at typecheck time — the verify script (not just the test run) must pass before the omission is caught.
