---
skill: respond-to-pr-review
issue: 356
pr: 385
round: 1
date: 2026-03-15
fixed_findings: [F1, F2, F3, F4, F5]
---
### F1: Event query chunk exceeds SQLite 999-param limit
**What was caught:** The book_events query binds eventType as an extra parameter, so 999-ID chunks produce 1000 parameters.
**Why I missed it:** I treated chunk size as a static constant (999) without analyzing the actual parameter count per query. The downloads query has 1 predicate (IN), but the events query has 2 (IN + eventType).
**Prompt fix:** Add to `/implement` general rules: "When implementing chunked IN(...) queries, count ALL bound parameters in each WHERE clause — not just the IN list. Reduce chunk size by 1 for each additional predicate."

### F2: No test for >999-ID chunking path
**What was caught:** The chunking logic was untested — only small arrays were covered.
**Why I missed it:** I wrote tests for the logical behavior (batch results, null cases) but not the mechanical splitting behavior. The spec's test plan said "Chunking >999 pending_review" but I didn't implement that specific test.
**Prompt fix:** Add to `/implement` test depth rule: "For any code with chunking/pagination logic, always include a test with inputs that exceed the chunk boundary to verify the splitting actually works."

### F3: Newest-event-wins contract untested
**What was caught:** No test feeds multiple events per download to verify ordering matters.
**Why I missed it:** I relied on the ORDER BY being correct without testing the dedup logic that depends on it.
**Prompt fix:** Add to `/plan` step 5 negative stubs: "For batch methods with ordering semantics (ORDER BY, first-write-wins), stub a test with duplicate keys to verify the correct item is selected."

### F4: Route error path for new service call untested
**What was caught:** New awaited call in try/catch has no 500-path test.
**Why I missed it:** I tested the happy path (batch fetch works) and the skip path (no pending), but didn't add an error path test for the new call.
**Prompt fix:** Add to `/implement` test depth rule: "For each new `await` added inside a route handler's try/catch, add a test where that specific call rejects and verify the route returns the expected error response."

### F5: ENOENT test didn't assert db.select untouched
**What was caught:** Test name claims "does not query DB" but only asserted getAll not called, not db.select.
**Why I missed it:** Updated the test name and the getAll assertion when switching to targeted queries, but didn't add the db.select assertion to match the new implementation.
**Prompt fix:** Add to `/handoff` self-review checklist: "For optimization tests that claim 'no query issued', verify the assertion matches the actual query mechanism (db.select, not bookService.getAll)."
