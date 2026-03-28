---
skill: respond-to-pr-review
issue: 341
pr: 347
round: 4
date: 2026-03-12
fixed_findings: [F21]
---

### F21: Missing tests for blacklistTtlDays and rssIntervalMinutes inline error branches
**What was caught:** Added error rendering for two fields in F20 fix but didn't add tests for the new branches.
**Why I missed it:** Treated the F20 fix as a source-only change (adding JSX) without considering it introduced new testable behavior. The F13-F19 lesson ("every validation needs a test") should have applied equally to new error rendering branches.
**Prompt fix:** Add to /respond-to-pr-review: "When a fix adds new render branches (conditional JSX, error messages, visibility toggles), add a test for EACH new branch in the same commit. Every `{errors.fieldName && ...}` added = one test asserting that error text renders for that specific field."
