---
skill: respond-to-pr-review
issue: 366
pr: 401
round: 1
date: 2026-03-16
fixed_findings: [F1, F2, F3, F4, F5, F6, F7, F8]
---

### F1: Migration drops new indexes
**What was caught:** The Drizzle migration dropped the new suggestions indexes as part of a global drop/recreate cycle.
**Why I missed it:** I ran `pnpm db:generate` and trusted the output without reading the full migration SQL. The drop/recreate pattern is Drizzle's default for SQLite index changes, but I didn't verify the recreate section included the new indexes.
**Prompt fix:** Add to `/implement` step 4b sibling check: "After committing a migration file, verify that every CREATE INDEX has a matching entry in the recreate section at the bottom of the file — Drizzle's SQLite migration drops ALL indexes then recreates them."

### F2: Missing author filter
**What was caught:** `GET /api/discover/suggestions` was only filterable by `reason`, not `author` as specified in AC8.
**Why I missed it:** The plan and test stubs only mentioned `reason` filtering. I implemented what the stubs called for without re-reading the AC which says "filterable by reason/author."
**Prompt fix:** Add to `/plan` step 5: "When generating route test stubs, cross-reference every query param and body field listed in the AC against the route schema. Create stubs for each named param."

### F3: Missing title+author fuzzy match
**What was caught:** Candidate exclusion only checked ASINs, not title+author fuzzy match.
**Why I missed it:** The ASIN check was the simple/fast path and I stopped there. The spec explicitly says "ASIN match OR title+author fuzzy match" but I implemented only one side of the OR.
**Prompt fix:** Add to `/implement` step 4: "When implementing filters that use OR conditions, verify both branches are implemented — the first branch is the fast path and the second is often forgotten."

### F4: Missing close-author-match filter
**What was caught:** Author-based queries passed raw results without checking if the returned author matches the queried author.
**Why I missed it:** The quality filters section in the spec says "Author name must be a close match to the queried author" but this was only applied during candidate generation, not at the filtering layer.
**Prompt fix:** Same as F3 — read the full quality filters section and implement each bullet point, not just the first few.

### F5: Silent error suppression
**What was caught:** `searchBooksForDiscovery` swallowed non-rate-limit errors silently instead of surfacing them via warnings.
**Why I missed it:** I reused `withThrottledSearch` which only appended to warnings for rate limits. The generic catch logged but didn't push to warnings.
**Prompt fix:** Add to `/implement` step 4: "When reusing internal methods for new public APIs with different error contracts, verify ALL catch branches in the shared method match the new contract."

### F6: No refreshSuggestions tests
**What was caught:** The core orchestration method had no direct test coverage.
**Why I missed it:** The method was called indirectly through route tests, but the lifecycle branches (insert, update, preserve, delete) were never individually asserted.
**Prompt fix:** Add to `/plan` step 5: "For orchestration methods that own multiple lifecycle branches (upsert/delete/preserve), create one test stub per branch — indirect coverage via route tests is insufficient."

### F7: Missing auth/validation/error route tests
**What was caught:** Route tests only covered happy paths + 404/409, not auth rejection, validation errors, or service error propagation.
**Why I missed it:** The `createTestApp` helper doesn't register the auth plugin, so auth tests need a separate app setup. I didn't think to test validation and error propagation because the happy paths were working.
**Prompt fix:** Add to `/plan` step 5 route stubs: "For every new route file, always create stubs for: (1) auth rejection (401 via separate auth-plugin app), (2) validation rejection (400 for invalid params), (3) service error propagation (500 from thrown error)."

### F8: No discovery interval test
**What was caught:** The timeout-loop scheduling wiring wasn't tested — a hard-coded interval or wrong settings category would pass.
**Why I missed it:** The existing test only checked task registration count, not the interval callback behavior.
**Prompt fix:** Add to `/plan` step 5: "When wiring a new job with configurable intervals, create a stub that asserts the settings category and interval conversion are correct."
