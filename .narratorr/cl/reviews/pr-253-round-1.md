---
skill: respond-to-pr-review
issue: 253
pr: 256
round: 1
date: 2026-03-31
fixed_findings: [F1, F2, F3, F4]
---

### F1: Service tests don't verify notExists predicate contract
**What was caught:** The 3 new service-level tests only asserted return values and `db.select` call counts — they couldn't distinguish a correct `notExists` predicate from an incorrect one.
**Why I missed it:** Over-reliance on the spec's "mocked tests verify branch logic, not SQL predicates" framing. I took this as permission to skip predicate assertions entirely, but the reviewer correctly pointed out that `mockDbChain` does expose `.where()` arguments.
**Prompt fix:** Add to `/implement` step 4a (red phase): "When adding or modifying a query predicate (WHERE clause), capture the mockDbChain and assert that `.where()` was called with arguments containing the expected SQL expression type (e.g., 'not exists' for notExists, column references for eq). Branch-only tests are insufficient for query changes."

### F2-F4: Missing caller-surface regression tests from approved spec test plan
**What was caught:** The spec's approved test plan explicitly listed 4 caller-surface regression tests (books route, library-scan x2, discovery), but implementation only added service-level tests.
**Why I missed it:** During implementation, I focused on the service-level tests from the plan and treated caller-surface tests as "already covered" since callers mock `findDuplicate` at the boundary. But the spec's test plan is a checklist — every item must be implemented.
**Prompt fix:** Add to `/implement` step 4a: "Cross-check every test case in the spec's ## Test Plan section against the tests you write. Each named test case maps to a real test — missing any is a guaranteed review finding. Caller-surface tests are especially easy to skip because they mock the service boundary, but they document the expected contract at each consumer."
