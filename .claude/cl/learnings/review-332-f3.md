---
scope: [backend]
files: [src/server/services/event-history.service.test.ts]
issue: 332
source: review
date: 2026-03-10
---
Wrote a pruning cutoff test that only asserted `db.delete` was called — didn't verify the actual operator (`lt` vs `lte`) or the cutoff Date value. The test would pass with any comparison operator or wrong date math. Fix: inspect Drizzle SQL expression internals via `queryChunks` — chunk[2].value[0] gives the operator string (e.g., ' < '), chunk[3].value gives the Param value. Use `vi.useFakeTimers` to pin Date.now() and assert the exact cutoff timestamp. Pattern: when testing DB predicates, assert the predicate's constraints (operator, value), not just that the query ran.
