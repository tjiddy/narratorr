---
skill: respond-to-spec-review
issue: 350
round: 1
date: 2026-03-14
fixed_findings: [F1, F2, F3]
---

### F1: C-1 test plan uses wrong assertion pattern
**What was caught:** The test plan proposed asserting row counts from mocked DB results, but service tests in this repo don't execute SQL — they inject mock rows. The correct pattern is capturing the Drizzle `where(...)` predicate and asserting it structurally.
**Why I missed it:** /elaborate's deep source analysis read the target service code but didn't check how existing tests in the same file verify query shapes. It assumed a row-filtering mock would prove the fix.
**Prompt fix:** Add to /elaborate step 10: "For every DB query the issue modifies, check co-located test files for the existing query-assertion pattern (predicate capture vs. row mocking) and require the test plan to follow the same approach."

### F2: Dead source reference to `debt-scan-findings.md`
**What was caught:** The spec's `## Source` section referenced a file that doesn't exist in the repository.
**Why I missed it:** /elaborate preserved the original issue content without verifying that cited file paths exist. The source reference was carried over from the original issue body without validation.
**Prompt fix:** Add to /elaborate step 6 (verify fixes): "Before updating the issue body, verify all file paths referenced anywhere in the spec body — including `## Source` — actually exist in the repository. Remove or rewrite dead references."

### F3: M-9 duplication surface incomplete
**What was caught:** A 5th instance of `book.path ? 'imported' : 'wanted'` exists in `download.service.ts:403-410` but wasn't listed in the spec.
**Why I missed it:** /elaborate's subagent checked the four locations listed in the original findings but didn't independently grep for the pattern to discover additional call sites.
**Prompt fix:** Add to /elaborate step 3 subagent prompt: "For DRY/dedup findings, always grep the full codebase for the duplicated pattern — don't trust the issue's listed locations as exhaustive."
