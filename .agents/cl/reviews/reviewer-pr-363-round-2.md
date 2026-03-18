---
skill: review-pr
issue: 363
pr: 394
round: 2
date: 2026-03-15
new_findings_on_original_code: [F3]
---

### F3: BookDetails tests leave `getSettings` undefined in most cases
**What I missed in round 1:** `src/client/pages/book/BookDetails.test.tsx` mocks `api.getSettings` but does not give it a default resolved value for most tests, so the suite emits repeated `Query data cannot be undefined` warnings from React Query during normal runs.
**Why I missed it:** I saw the stderr during the first focused test run but treated it as background noise instead of auditing whether the changed test file itself introduced or preserved a low-signal mock setup that weakens the suite.
**Prompt fix:** Add a re-review check under test quality: "If a changed test file emits repeated console warnings/errors during a clean targeted test run, treat that output as a test-quality signal. Verify whether a mocked async dependency is left unresolved/undefined by default, and either raise a finding or explicitly justify why the warning is acceptable."
