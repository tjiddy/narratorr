---
skill: respond-to-spec-review
issue: 349
round: 1
date: 2026-03-15
fixed_findings: [F1, F2, F3, F4]
---

### F1: Timeout-zero test case conflicts with schema
**What was caught:** Test plan asserted `postProcessingScriptTimeout: 0` is preserved, but schema enforces `min(1)`.
**Why I missed it:** `/elaborate` read the service code where `?? 300` is used but didn't cross-reference the Zod schema that validates the setting upstream. The subagent prompt asks to read service/util source but doesn't explicitly say "check schema validation for any setting values referenced in test cases."
**Prompt fix:** Add to `/elaborate` step 10 deep source analysis: "For any setting value used in a test case boundary condition, read the corresponding Zod schema in `src/shared/schemas/settings/` to verify the value can actually reach the code path being tested."

### F2: Error isolation language too broad
**What was caught:** Spec said all post-import phases are best-effort, but enrichment and DB writes still hard-fail.
**Why I missed it:** The `/elaborate` subagent correctly identified awaited-vs-fire-and-forget semantics, but when I wrote the test plan I grouped all steps after the copy as "post-import phases" without distinguishing which ones are inside the outer try/catch vs. have their own catch blocks.
**Prompt fix:** Add to `/elaborate` step 4 gap-fill: "When writing error-isolation test cases for extraction refactors, read the outer try/catch boundaries and classify each step as hard-fail (rejection triggers rollback) or best-effort (has its own catch, import continues). Never lump them together as 'post-import phases' without this classification."

### F3: Missing E2E regression suite names
**What was caught:** AC said "existing tests pass" without naming the 3 E2E test files that exercise import side effects.
**Why I missed it:** The subagent found the E2E suites but I didn't propagate them into the AC or test plan as durable content.
**Prompt fix:** Add to `/elaborate` step 4 durable content criteria: "When a refactor touches a method with E2E test coverage, add a 'Regression suites' section to the test plan naming the specific test files that must stay green."

### F4: Optional-service AC assumed uniform log level
**What was caught:** AC said "debug log" for missing services, but actual behavior varies (debug for broadcaster, warn for notifier/event-history).
**Why I missed it:** Didn't read the actual log level at each optional-chaining call site when writing the AC.
**Prompt fix:** Add to `/elaborate` step 10: "When documenting error/skip behavior for optional collaborators, note the specific log level used at each call site — don't assume uniformity."
