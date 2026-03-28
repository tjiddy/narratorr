---
skill: respond-to-pr-review
issue: 355
pr: 373
round: 1
date: 2026-03-14
fixed_findings: [F1, F2, F3]
---

### F1: Slim select drops more fields than spec allows
**What was caught:** The slim projection excluded `size` and `audio*` fields beyond the spec-approved `description` and `genres`.
**Why I missed it:** Built the slim select from memory of "what a list view needs" rather than from the schema. Didn't read the frontend consumers to verify which fields the library list actually uses.
**Prompt fix:** Add to `/implement` step 4 general rules: "When creating partial/slim selects, start from the full schema column list and subtract only the specified exclusions. Don't build include lists from memory — verify against the schema definition file."

### F2: Route-level pagination param tests missing
**What was caught:** All four route test suites were updated for the envelope response but never tested the new limit/offset query params or 400 validation.
**Why I missed it:** Focused on updating existing tests to not break (envelope shape) rather than adding new tests for the new query surface. The test stubs only covered service-level pagination, not route-level.
**Prompt fix:** Add to `/plan` test stub extraction: "When adding new query params to routes, always create test stubs for (1) happy-path param forwarding to service, and (2) invalid param rejection at the route boundary."

### F3: Service orderBy contract untested
**What was caught:** The stable sort order (AC5) was implemented but never asserted in tests.
**Why I missed it:** Treated the sort order as "implementation detail" rather than a spec requirement. AC5 explicitly names the sort contract, so it needs assertion coverage.
**Prompt fix:** Add to `/implement` step 4 general rules: "Every AC that specifies a query contract (sort order, filter behavior, join behavior) must have a test that asserts the contract — not just tests that verify the returned data shape."
