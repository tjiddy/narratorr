---
scope: [scope/backend, scope/services]
files: [src/server/services/import.service.ts]
issue: 361
source: spec-review
date: 2026-03-15
---
Spec review caught that AC permitted "private methods or extracted utility functions" but private methods don't reduce the file's line count — the file is 614 lines with a 400-line ESLint limit. The AC was self-contradictory: you can't remove the max-lines disable by only moving code within the same file.

Root cause: `/elaborate` didn't cross-reference the proposed refactoring strategy against the specific ESLint rule being violated. It checked that the eslint-disable existed but didn't verify that the proposed fix (private methods) could actually satisfy the lint rule.

Prevention: When a spec involves removing an eslint-disable override, check `eslint.config.js` for the actual threshold and verify the proposed approach produces a file below that threshold.
