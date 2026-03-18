---
skill: respond-to-pr-review
issue: 406
pr: 419
round: 1
date: 2026-03-17
fixed_findings: [F1, F2, F3]
---

### F1: API contract regression — refresh route returns {ok: true} instead of RefreshResult
**What was caught:** Switching manual refresh to TaskRegistry.runTask changed the response payload from the existing RefreshResult contract to {ok: true}.
**Why I missed it:** Focused on the concurrency protection requirement (AC7) without checking whether the existing API contract was preserved. The route test only asserted status code 200, not payload shape. The client-side type definition (RefreshResult) was never cross-referenced.
**Prompt fix:** Add to /plan step for route changes: "When modifying a route's execution path, verify the response payload still matches the client API type definition. Check `src/client/lib/api/` for the return type and ensure route tests assert payload shape, not just status codes."

### F2: Mock-only tests don't prove query predicates
**What was caught:** Dismissal ratio tests stubbed db.select() with pre-filtered data, so they'd pass even without the WHERE clause.
**Why I missed it:** Treated the unit tests as sufficient because the ratios came out correct. Didn't apply the existing toSQL() chain-inspection pattern already established in the same test file.
**Prompt fix:** Add to /implement test-writing guidance: "When testing query-building code with mock DBs, always add at least one test that inspects the query predicate via chain stubs (e.g., `chain.where` args). Pre-filtered mock data proves computation logic but not query correctness. Check if the test file already has a `toSQL()` or chain-inspection pattern to follow."

### F3: Multiplier threading tested on primary path only
**What was caught:** Resurfaced snoozed rows were never tested with non-default multipliers — all refresh integration tests used default (all 1.0) values.
**Why I missed it:** The resurfacing path was already tested for basic correctness, so I didn't think to exercise it with the new multiplier parameter. The spec's AC5 ("apply on next refresh cycle only") should have flagged every code path that receives multipliers as needing a non-default test.
**Prompt fix:** Add to /implement test-writing guidance: "When adding a parameter that threads through multiple code paths (e.g., multipliers passed to both generateCandidates and resurfaceSnoozedRows), write a test for each receiving path with non-default values. If only the primary path is tested, a broken secondary path is invisible."
