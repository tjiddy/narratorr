---
scope: [scope/services, scope/backend]
files: [src/server/services/discovery.service.ts, src/server/services/discovery.service.test.ts]
issue: 406
source: review
date: 2026-03-17
---
Reviewer caught that all dismissal ratio tests stubbed db.select() with pre-filtered data, so they'd still pass even if the WHERE clause filtering by ['dismissed', 'added'] was removed. This is a recurring pattern: when testing query-building code with mock DBs, you must assert the query predicates (where, groupBy, etc.) — not just the output from hand-crafted input. The test file already had a `toSQL()` helper and chain-inspection pattern from prior tests; should have applied it here too.
