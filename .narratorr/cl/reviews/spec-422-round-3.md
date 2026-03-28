---
skill: respond-to-spec-review
issue: 422
round: 3
date: 2026-03-17
fixed_findings: [F6]
---

### F6: AC3 named nonexistent `system.ts` consumer
**What was caught:** The spec said `system.ts` should import `searchAndGrabForBook` from `search-pipeline.ts` directly, but `system.ts` doesn't import that symbol at all.
**Why I missed it:** The previous round fixed AC2/AC1/AC4 but didn't re-verify AC3's consumer claims against the codebase. Trusted the original spec text instead of running `rg searchAndGrabForBook` to check which files actually import from `jobs/search.ts`.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 (verify fixes): "Also re-verify any existing spec claims that were NOT part of the current round's findings — reviewer corrections in one area can reveal stale assumptions elsewhere."
