---
skill: respond-to-pr-review
issue: 411
pr: 414
round: 1
date: 2026-03-16
fixed_findings: [F1, F2]
---

### F1: empty patch() still performs DB upsert
**What was caught:** `patch('category', {})` unconditionally called `set()`, performing a DB write even when no fields changed.
**Why I missed it:** Focused on the merge logic (spread operator correctness, falsy value preservation) and didn't add a guard for the degenerate empty-input case, even though the spec's test plan explicitly listed it as a no-op edge case.
**Prompt fix:** Add to `/plan` step where test stubs are extracted: "For each edge case in the spec's test plan, verify the implementation has an explicit code path — especially no-op/empty-input cases that should short-circuit before any side effects."

### F2: empty-partial test only asserted return value
**What was caught:** Test for `patch('search', {})` checked the returned object but didn't assert `db.insert` was never called, so it couldn't detect the unnecessary write.
**Why I missed it:** Wrote the test as "returns existing values unchanged" but didn't think about the side-effect half of the no-op contract.
**Prompt fix:** Add to testing standards or `/implement`: "When testing no-op or short-circuit behaviors, assert both the return value AND the absence of side effects (e.g., `expect(db.insert).not.toHaveBeenCalled()`). A no-op test that only checks output is half a test."
