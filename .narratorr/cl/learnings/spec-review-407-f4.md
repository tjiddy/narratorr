---
scope: [scope/backend]
files: []
issue: 407
source: spec-review
date: 2026-03-17
---
Reviewer caught that the fixture blast radius section only mentioned `getStrengthForReason()` and the client row type, understating the actual test/mock churn across 4+ test files and 6+ source files.

Root cause: Wrote the blast radius as an afterthought rather than systematically grepping for reason literal usages in test files.

Prevention: For blast radius sections, grep for the exact literals being extended (e.g., `'author' | 'series' | 'genre' | 'narrator'`) in both source and test files, then list every hit with what kind of change is needed.
