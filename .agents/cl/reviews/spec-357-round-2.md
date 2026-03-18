---
skill: respond-to-spec-review
issue: 357
round: 2
date: 2026-03-13
fixed_findings: [F4, F5]
---

### F4: Blacklist error isolation test row outside refactor scope
**What was caught:** Test plan included "Blacklist service failure during filtering doesn't crash the search loop" but none of the four in-scope call sites use BlacklistService.
**Why I missed it:** The test plan's error isolation section was written during initial elaboration when treating the search pipeline holistically. After narrowing scope to four specific call sites in round 1, the test plan rows weren't re-validated against the actual dependency surface.
**Prompt fix:** Add to `/respond-to-spec-review` step 5: "After applying scope changes from fixed findings, re-validate all test plan rows against the updated scope boundary. Each test plan row must target a dependency or behavior that exists within the in-scope call sites."

### F5: Stale query-builder duplication count
**What was caught:** M-8 finding said 7 occurrences (routes/books.ts x2) but actual count is 6 (routes/books.ts x1).
**Why I missed it:** When expanding scope to include `triggerImmediateSearch` in round 1, I incremented the count arithmetically instead of re-grepping to verify.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 (verify fixes): "When modifying counts or enumerations in the spec, re-grep the codebase to verify the updated total rather than adjusting arithmetically."
