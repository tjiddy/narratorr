---
scope: [scope/backend]
files: []
issue: 408
source: spec-review
date: 2026-03-17
---
Reviewer caught that the test plan referenced `{ expired: 0 }` as a return value while the spec also said `RefreshResult` was unchanged. The contradiction was introduced when fixing round 1 — the original `{ expired: 0 }` test language survived the RefreshResult-unchanged decision. Prevention: when resolving a contract question (e.g., "does the return shape change?"), grep the entire spec for all references to the affected fields and update them consistently. Don't just fix the contract section.
