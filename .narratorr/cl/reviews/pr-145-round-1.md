---
skill: respond-to-pr-review
issue: 145
pr: 153
round: 1
date: 2026-03-26
fixed_findings: [F1]
---

### F1: fileFormat trim behavior only partially asserted

**What was caught:** `libraryFormSchema.fileFormat` gained `.trim()` but tests only checked `success === false` for whitespace-only input. No exact error-message assertion proved the failure was from `.min(1)` post-trim (vs `.refine()`), and no test proved valid spaced template strings are normalized before refine.

**Why I missed it:** When fixing sibling fields in the same schema, I wrote the exact error-message assertion for `folderFormat` first, then added a similar `rejects whitespace-only fileFormat` test for `fileFormat` — but only at the `success === false` level. The trim-normalization test I wrote only covered `path`, not the template fields. The pattern of "one sibling gets the deep assertion, others get shallow" is easy to miss during implementation.

**Prompt fix:** Add to `/plan` step for schema changes: "When adding `.trim()` to N sibling fields in the same schema, the test plan must include (a) an exact error-message assertion for *each* field's whitespace-only case (not just the first), and (b) a single test that passes spaced-but-valid values for all affected sibling fields and asserts every output is trimmed. Mark it as a gap during test stub extraction if any sibling lacks its own message-level assertion."
