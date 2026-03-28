---
skill: respond-to-pr-review
issue: 8
pr: 13
round: 2
date: 2026-03-19
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: deleteCredentials test only proved db.delete ran, not that mode was reset
**What was caught:** The test asserted `db.delete` was called but not the values written by `setAuthConfig`. A regression removing the mode reset would pass.
**Why I missed it:** I wrote the test to prove the operation ran, not to prove the contract. The existing `initialize` test already showed the right pattern (asserting `db.insert.mock.results[0].value.values.mock.calls[0][0]`) but I didn't apply it to the new test.
**Prompt fix:** Add to `/plan` step for service tests: "For service methods that read-modify-write config, assert the full shape of the persisted object (all fields including mode, preserved secrets) using `db.insert.mock.results[N].value.values.mock.calls[0][0]` — not just that `db.insert` was called."

### F2: sliding-renewal cookie not asserted for Secure absence
**What was caught:** The sliding-renewal test in auth.plugin.test.ts only checked that the cookie existed and had the right value — not that it lacked `Secure`.
**Why I missed it:** When verifying a cookie attribute change, I checked the most prominent tests (login/logout) and missed the renewal path. Blast-radius check should cover all `setCookie` call sites.
**Prompt fix:** Add to CLAUDE.md gotchas: "Cookie attribute changes (Secure, HttpOnly, SameSite) must be tested at every setCookie call site — grep `setCookie` and `reply.setCookie` to enumerate all paths before writing tests."

### F3: no page-level test for bypassActive prop wiring in SecuritySettings
**What was caught:** CredentialsSection tests proved the child mutation runs; they couldn't prove SecuritySettings correctly passes `authStatus.bypassActive` from query data or that invalidation causes the correct UI transition.
**Why I missed it:** I wrote tests at the child component level and treated the parent as a thin wrapper. But the parent-to-child query wiring is a distinct behavior that only a page-level test can exercise.
**Prompt fix:** Add to `/plan` for frontend features: "When a parent passes a reactive prop from a query into a child, add a page-level test that (1) resolves initial query, (2) triggers mutation, (3) resolves refetch to post-action state, (4) asserts resulting UI. Child tests alone cannot prove parent wiring."

### F4: login theme tests pre-seeded DOM rather than exercising bootstrap logic
**What was caught:** Tests that set `classList.add('dark')` before rendering then asserted the component didn't remove it — these pass even if the bootstrap script is deleted.
**Why I missed it:** I wrote regression tests that checked the component's passive behavior (doesn't touch classes) rather than the active bootstrap logic (reads storage/matchMedia, applies class). Inline IIFE logic needs extraction to be testable.
**Prompt fix:** Add to CLAUDE.md gotchas: "Inline IIFE logic in index.html is not testable. Any IIFE with decision branches (localStorage/matchMedia → class toggle) must be extracted into a TypeScript module. Pre-seeding DOM state in component tests is not a substitute — it doesn't exercise the selection logic."

### F5: DELETE /api/auth/credentials missing 500 error path test
**What was caught:** Two-branch catch block (NoCredentialsError → 404, other → 500) had only one branch tested.
**Why I missed it:** I wrote tests for the documented error cases (403, 404, 200) but didn't systematically test every catch branch. The rule "every catch branch gets a test" wasn't applied.
**Prompt fix:** Add to `/plan` for route tests: "For every catch block with multiple error type branches, write one test per branch — especially the generic Error → 500 path. This is the path most likely to break silently."
