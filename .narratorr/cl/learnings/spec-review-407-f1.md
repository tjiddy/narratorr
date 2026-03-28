---
scope: [scope/backend]
files: []
issue: 407
source: spec-review
date: 2026-03-17
---
Reviewer caught that the "guaranteed slot" design assumed a book could exist as both an affinity row and a diversity row simultaneously, but the suggestions table has a unique index on `asin`. The spec's test case "Same ASIN in both affinity and diversity" was not implementable under the current schema.

Root cause: Wrote the design decision (separate insertion queue) without checking the persistence constraints. The unique index on `asin` in `src/db/schema.ts:334` makes dual-row storage impossible.

Prevention: When a spec proposes a new data flow, verify it against existing schema constraints (unique indexes, NOT NULL, enums) before writing AC test cases that assume the flow works.
