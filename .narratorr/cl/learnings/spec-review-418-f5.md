---
scope: [scope/backend, scope/frontend]
files: []
issue: 418
source: spec-review
date: 2026-03-17
---
Reviewer caught that the fixture blast-radius section listed `activity.test.ts` and `quality-gate.service.test.ts` (which don't reference suggestion reasons) and missed `discover.test.ts` and `discovery.test.ts` (which do). Root cause: I inferred test file impact from file names and proximity rather than grepping for actual reason string usage. Prevention: always grep test files for the specific string literals being refactored to build the blast-radius list, rather than guessing from file names.