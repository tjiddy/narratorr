---
skill: respond-to-pr-review
issue: 372
pr: 396
round: 3
date: 2026-03-16
fixed_findings: [F1, F2, F3]
---

### F1: API contract tests missing for new query builders
**What was caught:** New/changed API client query builders (parameterized getActivity, getBlacklist, getEventHistory, getBooks + new getBookStats, getBookIdentifiers) had no contract tests.
**Why I missed it:** I treated the API contract test file as "already covered" since the base methods existed. When adding query params and new methods, I didn't check if the contract suite needed updating.
**Prompt fix:** Add to `/implement` step 4d (sibling enumeration): "When adding or modifying API client methods in `src/client/lib/api/*.ts`, check `api-contracts.test.ts` for corresponding contract tests. Every new method or changed URL pattern needs a contract test asserting the exact fetch path."

### F2: Hook tests missing for new query wrappers
**What was caught:** `useBookIdentifiers()` and `useBookStats()` were new hooks with no test coverage.
**Why I missed it:** I added them as simple one-line wrappers and assumed they were trivially correct. But even simple hooks need tests to catch wrong query keys or wrong API method references.
**Prompt fix:** Add to `/implement` step 4a (test depth rule): "Every new exported hook must have at least one test, even if it's a simple query wrapper. Test that it calls the right API method and exposes the right data shape."

### F3: BookEditModal duplicate badge not tested with identifier records
**What was caught:** The test mock hardcoded `useBookIdentifiers` to return empty data, so no test exercised the duplicate badge path.
**Why I missed it:** When updating the mock from `useLibrary` to `useBookIdentifiers`, I only fixed the mock to make existing tests pass — I didn't add a new test exercising the new code path.
**Prompt fix:** Add to `/respond-to-pr-review` step 3 (sibling pattern check): "When updating test mocks to match a new hook/API method, add at least one test that exercises the new data path, not just tests that pass with empty/default data."
