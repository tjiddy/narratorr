---
skill: respond-to-pr-review
issue: 408
pr: 416
round: 2
date: 2026-03-17
fixed_findings: [F1, F2, F3, F4, F5, F6, F7]
---

### F1: Active snoozed suggestions deleted as stale during refresh
**What was caught:** The stale-delete filter only excluded regenerated and resurfaced rows, not future-snoozed ones.
**Why I missed it:** The stale-delete logic was written linearly — "regenerated? keep. resurfaced? keep. else delete." — without considering that a third category (actively snoozed, not yet due) also needs preservation. The interaction between snooze lifecycle and stale cleanup wasn't surfaced during implementation.
**Prompt fix:** Add to /plan step exploring refresh logic: "When adding new row states (snoozed, locked, etc.), enumerate ALL deletion/cleanup filters and verify each new state is handled — not just the happy path (resurfaced) but also the wait path (still snoozed)."

### F2: Resurfaced snoozed rows rescored with hardcoded fallback
**What was caught:** `computeResurfacedScore()` used a hardcoded weight multiplier instead of the real `scoreCandidate` algorithm with signals.
**Why I missed it:** Treated resurfacing as a "simplified" path where full scoring wasn't needed, when the AC explicitly says "fresh score." Didn't question whether the simplified approach satisfied the AC contract.
**Prompt fix:** Add to /implement: "When an AC says 'same algorithm' or 'fresh score,' the implementation must call the same code path — not a reimplementation. If the existing method needs data not available in the current context, expand the data query rather than writing a shortcut."

### F3: No getSuggestions() snooze visibility test
**What was caught:** getSuggestions() filter change had no dedicated test.
**Why I missed it:** Existing tests covered the method, so I treated the WHERE clause change as covered. But the new filter branch was never exercised.
**Prompt fix:** Add to /implement test-writing step: "When modifying a query's WHERE clause, add a test specifically for the new filter condition — don't rely on existing tests that predate the change."

### F4: Expiry delete predicate not asserted
**What was caught:** Test only asserted `db.delete` was called, not the WHERE predicate shape.
**Why I missed it:** Followed the pattern of "assert the operation happened" without asserting the arguments. The race-safety contract (AC8) depends on the predicate, not just the operation.
**Prompt fix:** Add to testing.md: "For DB operations guarding race conditions (DELETE/UPDATE with specific WHERE predicates), assert the predicate arguments — not just that the operation was called. toHaveBeenCalled() cannot catch predicate regressions."

### F5: AC6 resurfacing test too weak
**What was caught:** Test asserted `db.update` called but not the `.set()` payload values (score, snoozeUntil:null, no reason overwrite).
**Why I missed it:** Wrote the test to prove the code path executed rather than to prove the contract was correct.
**Prompt fix:** Already covered by testing.md "Assert arguments, not just invocation" — the gap was not following the existing standard. Add a checklist item to /implement: "Before committing a test, re-read each assertion and ask: could this pass with wrong arguments?"

### F6: No test for still-snoozed row surviving refresh
**What was caught:** The future-snooze branch was independently breakable from the resurfacing branch.
**Why I missed it:** Only tested the "interesting" path (resurfacing) and assumed the "do nothing" path (still snoozed) was trivially correct.
**Prompt fix:** Add to /implement: "When implementing complementary branches (active vs expired, found vs missing), always test both sides — especially the 'no-op' branch, since it's the one most likely to regress silently."

### F7: Refresh route warnings passthrough not tested
**What was caught:** Route test didn't verify the new `warnings` field in the response body.
**Why I missed it:** The route test for refresh already existed and asserted status 200. Didn't add a test for the new response shape.
**Prompt fix:** Add to /implement: "When a service return type gains a new field, add a route test that verifies the field survives serialization to the HTTP response."
